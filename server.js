const express = require("express");
const fs = require("fs").promises;
const fsSync = require("fs");
const cors = require("cors");
const path = require("path");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const axios = require("axios");

const app = express();
const port = 3000;

app.use(express.json());
app.use(cors());

const DB_FILE = "./credentials.json";
const SERVE_FILE = "./serve.json";
const JWT_SECRET = "super_secret_jwt_signature_key_change_me";
const SALT_ROUNDS = 10;

// Security limiters
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: "Too many login attempts." } });
const createAccountLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: { error: "Too many accounts created." } });

// Initialization
if (!fsSync.existsSync(DB_FILE)) fsSync.writeFileSync(DB_FILE, JSON.stringify({ users: [] }, null, 2));
if (!fsSync.existsSync(SERVE_FILE)) fsSync.writeFileSync(SERVE_FILE, JSON.stringify(["index.html", "login.html", "signup.html", "404.html"], null, 2));

// Helpers
async function readDB() { return JSON.parse(await fs.readFile(DB_FILE, "utf-8")); }
async function writeDB(data) { await fs.writeFile(DB_FILE, JSON.stringify(data, null, 2)); }
function send404(res) {
  let file = path.join(__dirname, "404.html");
  fsSync.existsSync(file) ? res.status(404).sendFile(file) : res.status(404).send("404 Not Found");
}

/* --- SECURITY MIDDLEWARE --- */
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Access denied" });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Invalid token" });
    req.user = user;
    next();
  });
}

// --- API KEY HELPERS ---
const API_KEY_FILE = "api-key.json";

async function readApiKeys() {
  try {
    if (!fsSync.existsSync(API_KEY_FILE)) {
      await fs.writeFile(API_KEY_FILE, "{}");
      return {};
    }
    const data = await fs.readFile(API_KEY_FILE, "utf-8");
    if (!data) return {};
    return JSON.parse(data);
  } catch (err) {
    console.error("readApiKeys error:", err);
    return {};
  }
}

async function writeApiKeys(data) {
  try {
    await fs.writeFile(API_KEY_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("writeApiKeys error:", err);
    throw err;
  }
}

// --- CORE API ---

/* Create Account */
app.post("/end/create-account", createAccountLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "missing_fields" });
  if (username.length < 3 || username.length > 9) return res.status(400).json({ error: "username_length" });

  try {
    let db = await readDB();
    if (db.users.find(u => u.username === username)) return res.status(409).json({ error: "username_exists" });

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const newUser = {
      username,
      password: hashedPassword,
      rank: "member",
      tokens: 500,
      created_at: new Date().toISOString(),
      history: []
    };

    db.users.push(newUser);
    await writeDB(db);

    const token = jwt.sign({ username: newUser.username, rank: newUser.rank }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ success: true, token, rank: newUser.rank });
  } catch (error) {
    console.error("Signup Error:", error);
    res.status(500).json({ error: "server_error" });
  }
});

/* Login */
app.post("/end/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "missing_fields" });

  try {
    let db = await readDB();
    let user = db.users.find(u => u.username === username);
    if (!user) return res.status(401).json({ valid: false, error: "Invalid credentials" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ valid: false, error: "Invalid credentials" });

    const token = jwt.sign({ username: user.username, rank: user.rank }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ valid: true, token, tokens: user.tokens, rank: user.rank });
  } catch (error) {
    console.error("Login Error:", error);
    res.status(500).json({ valid: false, error: "server_error" });
  }
});

/* Live Data Refresh */
app.get("/end/me", authenticateToken, async (req, res) => {
  try {
    let db = await readDB();
    let user = db.users.find(u => u.username === req.user.username);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ username: user.username, rank: user.rank, tokens: user.tokens });
  } catch (error) {
    res.status(500).json({ error: "server_error" });
  }
});

/* Create API Key */
app.post("/end/create-api-key", async (req, res) => {
  const { username, password, name } = req.body;
  if (!username || !password || !name) return res.status(400).json({ error: "missing_fields" });

  try {
    const db = await readDB();
    const user = db.users.find(u => u.username === username);
    if (!user) return res.status(401).json({ error: "invalid_credentials" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "invalid_credentials" });

    const apiKey = "nyxo_" + crypto.randomBytes(16).toString("hex");
    const keys = await readApiKeys();
    if (!keys[username]) keys[username] = {};
    keys[username][name] = apiKey;

    await writeApiKeys(keys);
    res.json({ success: true, name, apiKey });
  } catch (err) {
    console.error("Create API Key Error:", err);
    res.status(500).json({ error: "server_error" });
  }
});

/* Get API Keys */
app.post("/end/get-api", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "missing_fields" });

  try {
    const db = await readDB();
    const user = db.users.find(u => u.username === username);
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });

    const keys = await readApiKeys();
    res.json({ apiKeys: keys[username] || {} });
  } catch (err) {
    console.error("Get API Keys Error:", err);
    res.status(500).json({ error: "server_error" });
  }
});

/* Get Profile */
app.post("/end/get-profile", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "missing_fields" });

  try {
    let db = await readDB();
    let user = db.users.find(u => u.username === username);
    if (!user) return res.status(401).json({ error: "invalid_credentials" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ error: "invalid_credentials" });

    const { password: pwd, ...userData } = user;
    res.json(userData);
  } catch (error) {
    console.error("Get Profile Error:", error);
    res.status(500).json({ error: "server_error" });
  }
});

/* Change Profile */
app.post("/api/change-profile", async (req, res) => {
  const { oldUsername, oldPassword, newUsername, newPassword } = req.body;
  if (!oldUsername || !oldPassword || !newUsername || !newPassword)
    return res.status(400).json({ error: "missing_fields" });

  try {
    const db = await readDB();
    const user = db.users.find(u => u.username === oldUsername);
    if (!user) return res.status(401).json({ error: "invalid_credentials" });

    const match = await bcrypt.compare(oldPassword, user.password);
    if (!match) return res.status(401).json({ error: "invalid_credentials" });

    if (oldUsername !== newUsername) {
      const exists = db.users.find(u => u.username === newUsername);
      if (exists) return res.status(409).json({ error: "name_already_exists" });
    }

    const newHashedPassword = await bcrypt.hash(newPassword, SALT_ROUNDS);
    user.username = newUsername;
    user.password = newHashedPassword;

    await writeDB(db);
    res.json({ success: true, message: "Credentials Saved Successfully" });
  } catch (err) {
    console.error("Change Profile Error:", err);
    res.status(500).json({ error: "server_error" });
  }
});

/* Assistant (OpenRouter) */
app.post("/api/assistant", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "missing_message" });

  const OPENROUTER_API_KEY = "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";

  try {
    const trainingPrompt = await fs.readFile("./training/assistant.txt", "utf-8");

    const requestBody = {
      model: "openrouter/free",
      messages: [
        { role: "system", content: trainingPrompt },
        { role: "user", content: message }
      ],
      max_tokens: 64000
    };

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });

    const data = await response.json();
    res.json({ reply: data.choices?.[0]?.message?.content || "No response" });
  } catch (err) {
    console.error("Assistant API Error:", err);
    res.status(500).json({ error: "assistant_failed" });
  }
});

/* Get Model Data */
const MODELS_FILE = "./models.json";

app.get("/end/get-model-data", async (req, res) => {
  try {
    if (!fsSync.existsSync(MODELS_FILE)) {
      return res.status(404).json({ error: "models_file_not_found" });
    }
    const data = await fs.readFile(MODELS_FILE, "utf-8");
    const models = JSON.parse(data);
    res.json(models);
  } catch (err) {
    console.error("Get Models Error:", err);
    res.status(500).json({ error: "server_error" });
  }
});

/* Assistant V1 (Bytez - Full Featured) */
app.post("/api/v1/assistant", async (req, res) => {
  let {
    username,
    apiKey,
    message,
    memory = "",
    skills = "",
    think = "LOW",
    crawling = [],
    compare = null,
    modelKey,
    temperature = 0.5
  } = req.body;

  if (!username || !apiKey || !message || !modelKey) {
    return res.status(400).json({ error: "nyxoAI_missing_fields" });
  }

  try {
    const db = await readDB();
    const user = db.users.find(u => u.username === username);
    if (!user) return res.status(401).json({ error: "nyxoAI_invalid_user" });

    const apiKeys = await readApiKeys();
    if (!apiKeys[username] || !Object.values(apiKeys[username]).includes(apiKey)) {
      return res.status(403).json({ error: "nyxoAI_invalid_api_key" });
    }

    // --- LIMIT INPUTS ---
    const LIMITS = { message: 20000, memory: 20000, skills: 10000, crawl: 50000 };
    message = message.slice(0, LIMITS.message);
    memory = memory.slice(0, LIMITS.memory);
    skills = skills.slice(0, LIMITS.skills);
    if (!Array.isArray(crawling)) crawling = [];

    // --- TOKEN COUNT ---
    const count = (str) => Buffer.byteLength(str || "", "utf-8");
    let usedTokens = count(message) + count(memory) + count(skills);

    // --- CRAWLING ---
    let crawlText = "";
    for (let url of crawling) {
      try {
        const resp = await axios.get(url, { timeout: 8000 });
        let text = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data);
        text = text.slice(0, LIMITS.crawl);
        crawlText += text;
        usedTokens += count(text);
      } catch {
        continue;
      }
    }

    let tokens = user.tokens;
    if (tokens - usedTokens <= 0) {
      return res.status(400).json({ error: "nyxoAI_not_enough_tokens" });
    }

    let remaining = tokens - usedTokens;
    if (remaining < 1) remaining = 1;
    let max_length = remaining > 128000 ? 128000 : remaining;

    // --- BUILD PROMPT ---
    let finalPrompt = "";
    if (memory) finalPrompt += `THIS IS YOUR MEMORY:\n${memory}\n\n`;
    if (skills) finalPrompt += `THIS IS YOUR SKILLS:\n${skills}\n\n`;
    finalPrompt += `THINK ${think}\n\n`;
    if (crawlText) finalPrompt += `CRAWLED DATA:\n${crawlText}\n\n`;
    finalPrompt += `USER MESSAGE:\n${message}`;

    // --- LOAD MODELS ---
    const models = JSON.parse(await fs.readFile("./models.json", "utf-8"));
    const mainModel = models[modelKey];
    if (!mainModel) {
      return res.status(400).json({ error: "nyxoAI_invalid_model" });
    }

    // --- CALL MODEL ---
    async function callModel(model, prompt) {
      const keys = process.env.BYTEZ_KEYS.split(",");
      for (let key of keys) {
        try {
          const response = await axios.post(
            `https://api.bytez.com/models/v2/${model.key}`,
            {
              messages: [{ role: "user", content: prompt }],
              stream: false,
              params: { min_length: 1, max_length, temperature }
            },
            {
              headers: { Authorization: key, "Content-Type": "application/json" }
            }
          );
          return response.data;
        } catch {
          continue;
        }
      }
      throw new Error("all_keys_failed");
    }

    const extractText = (res) => {
      try {
        return res.choices?.[0]?.message?.content || JSON.stringify(res);
      } catch {
        return JSON.stringify(res);
      }
    };

    // --- MAIN RESPONSE ---
    const mainResponse = await callModel(mainModel, finalPrompt);
    const mainText = extractText(mainResponse);

    let result = {};
    result[modelKey] = mainText;

    // --- COMPARE ---
    if (compare) {
      const compareModel = models[compare];
      if (!compareModel) {
        return res.status(400).json({ error: "nyxoAI_invalid_compare_model" });
      }
      const compareResponse = await callModel(compareModel, finalPrompt);
      result[compare] = extractText(compareResponse);

      if (!compareModel.usage) compareModel.usage = [];
      compareModel.usage.unshift(`${new Date().toISOString().split("T")[0]}[*]${usedTokens}`);
      if (compareModel.usage.length > 30) compareModel.usage.pop();
    }

    // --- TOKEN UPDATE ---
    const outputTokens = count(mainText);
    let finalTokens = remaining - outputTokens;
    if (finalTokens < 0) finalTokens = 0;
    user.tokens = finalTokens;

    // --- HISTORY ---
    const date = new Date().toISOString().split("T")[0];
    if (!user.history) user.history = [];
    user.history.unshift({ model: modelKey, token: String(usedTokens), date });
    if (user.history.length > 30) user.history.pop();

    // --- MODEL USAGE ---
    if (!mainModel.usage) mainModel.usage = [];
    mainModel.usage.unshift(`${date}[*]${usedTokens}`);
    if (mainModel.usage.length > 30) mainModel.usage.pop();

    // --- SAVE ---
    await writeDB(db);
    await fs.writeFile("./models.json", JSON.stringify(models, null, 2));

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "nyxoAI_server_error" });
  }
});

// --- ROUTING ---
app.get("/img/:filename", (req, res) => {
  if (req.headers["sec-fetch-dest"] === "document" || !req.headers["referer"]) return send404(res);
  let file = path.join(__dirname, "img", req.params.filename);
  fsSync.existsSync(file) ? res.sendFile(file) : send404(res);
});

app.get("/", async (req, res) => {
  let allowed = JSON.parse(await fs.readFile(SERVE_FILE, "utf-8"));
  allowed.includes("index.html") ? res.sendFile(path.join(__dirname, "index.html")) : send404(res);
});

app.get("/:page", async (req, res) => {
  let page = req.params.page.endsWith(".html") ? req.params.page : req.params.page + ".html";
  let allowed = JSON.parse(await fs.readFile(SERVE_FILE, "utf-8"));
  if (!allowed.includes(page)) return send404(res);
  let file = path.join(__dirname, page);
  fsSync.existsSync(file) ? res.sendFile(file) : send404(res);
});

app.use((req, res) => send404(res));
app.listen(port, () => console.log(`Secure server running on port ${port}`));
