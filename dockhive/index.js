const express = require("express");
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const server = http.createServer(app);

app.set("trust proxy", true);
app.use(express.json());

const PAGES_PATH = "/platform/pages";
const PORT = 3000;

const DATA_DIR = "/platform/data";
const CREDS_FILE = path.join(DATA_DIR, "credentials.json");

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;

function readCreds() {
  try {
    if (!fs.existsSync(CREDS_FILE)) return {};
    return JSON.parse(fs.readFileSync(CREDS_FILE, "utf-8"));
  } catch (e) {
    console.error("[creds] read failed:", e.message);
    return {};
  }
}

function writeCreds(data) {
  try {
    fs.writeFileSync(CREDS_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    console.error("[creds] write failed:", e.message);
    return false;
  }
}

function getClientIp(req) {
  return (req.ip || req.connection.remoteAddress || "").replace("::ffff:", "");
}

function findUserByIp(creds, ip) {
  for (const username of Object.keys(creds)) {
    if (creds[username].ip === ip) return username;
  }
  return null;
}

function generatePassword(length = 32) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
  return out;
}

async function exchangeDiscordCode(code) {
  const resp = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: DISCORD_REDIRECT_URI,
    }),
  });
  const data = await resp.json();
  if (!data.access_token) return null;

  const userResp = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${data.access_token}` },
  });
  if (!userResp.ok) return null;
  const user = await userResp.json();

  const avatarUrl = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
    : `https://cdn.discordapp.com/embed/avatars/${Number(user.discriminator || 0) % 5}.png`;

  return {
    provider: "discord",
    username: user.username,
    email: user.email || null,
    imgUrl: avatarUrl,
  };
}

app.post("/api/register", async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ status: "error", message: "Missing code" });

  const ip = getClientIp(req);

  const identity = await exchangeDiscordCode(code).catch(() => null);

  if (!identity) {
    return res.status(401).json({ status: "error", message: "Code invalid for Discord" });
  }

  const creds = readCreds();

  const existingByIp = findUserByIp(creds, ip);
  if (existingByIp) {
    return res.json({
      status: "success",
      username: existingByIp,
      password: creds[existingByIp].pass,
    });
  }

  if (creds[identity.username]) {
    return res.json({
      status: "success",
      username: identity.username,
      password: creds[identity.username].pass,
    });
  }

  const password = generatePassword(32);
  creds[identity.username] = {
    pass: password,
    servers: [],
    ip,
    imgUrl: identity.imgUrl,
    credits: 0,
    email: identity.email,
  };

  const saved = writeCreds(creds);
  if (!saved) {
    return res.status(500).json({ status: "error", message: "Failed to save user" });
  }

  return res.json({
    status: "success",
    username: identity.username,
    password,
  });
});

app.post("/api/get-user", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ status: "error", message: "Missing username or password" });
  }

  const creds = readCreds();
  const user = creds[username];

  if (!user || user.pass !== password) {
    return res.status(401).json({ status: "error", message: "Invalid credentials" });
  }

  return res.json({ status: "success", username, data: user });
});

app.use(express.static(PAGES_PATH));

app.get(/.*/, (req, res) => {
  let file = req.path === "/" ? "index.html" : req.path.slice(1);

  if (!path.extname(file)) file += ".html";

  const filePath = path.join(PAGES_PATH, file);

  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    const notFoundPage = path.join(PAGES_PATH, "404.html");
    if (fs.existsSync(notFoundPage)) {
      res.status(404).sendFile(notFoundPage);
    } else {
      res.status(404).send("Not Found");
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Pages server running on port ${PORT}, serving ${PAGES_PATH}`);
});
