const express = require("express");
const fs = require("fs");
const path = require("path");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();

const MAIN_APP_PORT = 3560;

function getDB() {
  try {
    const raw = fs.readFileSync(
      path.join(__dirname, "../data/ports.json"),
      "utf-8"
    );
    return JSON.parse(raw);
  } catch (err) {
    console.error("DB Read Error:", err);
    return {};
  }
}

function getPort(value) {
  if (!value) return null;
  if (typeof value === "number") return value;

  const str = String(value).trim();

  if (str.includes(":")) {
    return Number(str.split(":")[1]);
  }

  return Number(str);
}

function getSubdomain(host) {
  if (!host) return null;

  const clean = host.split(":")[0].toLowerCase().trim();
  const parts = clean.split(".");

  if (parts.length < 3) return null;

  return parts[0];
}

app.use((req, res, next) => {
  const host = req.headers.host;

  const cleanHost = host.split(":")[0].toLowerCase();

  // 🌐 IF DOMAIN STARTS WITH cloudra → MAIN APP
  if (cleanHost.startsWith("cloudra")) {
    return createProxyMiddleware({
      target: `http://127.0.0.1:${MAIN_APP_PORT}`,
      changeOrigin: true,
      ws: true,
      xfwd: true
    })(req, res, next);
  }

  const subdomain = getSubdomain(host);

  const db = getDB();

  const normalizedDB = Object.fromEntries(
    Object.entries(db).map(([k, v]) => [k.toLowerCase().trim(), v])
  );

  if (!subdomain) {
    return res.status(404).send("App not found");
  }

  const appData = normalizedDB[subdomain];

  if (!appData) {
    return res.status(404).send("App not found");
  }

  if (appData.status && appData.status !== "active") {
    return res.status(403).send("App is suspended");
  }

  const port = getPort(appData.port);

  if (!port || isNaN(port)) {
    return res.status(500).send("Invalid port config");
  }

  return createProxyMiddleware({
    target: `http://127.0.0.1:${port}`,
    changeOrigin: true,
    ws: true,
    xfwd: true,
    onError(err, req, res) {
      console.error("Proxy error:", err.message);
      res.status(502).send("Bad gateway");
    }
  })(req, res, next);
});

app.listen(5000, () => {
  console.log("Router running on port 5000");
});
