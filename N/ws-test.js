"use strict";

const http    = require("http");
const path    = require("path");
const fs      = require("fs");
const express = require("express");
const { WebSocketServer } = require("ws");
const { spawn }           = require("child_process");
const pty                 = require("node-pty");

const PORT       = 4000;
const DATA_DIR   = "/platform/data";
const APPS_FILE  = path.join(DATA_DIR, "apps.json");
const CREDS_FILE = path.join(DATA_DIR, "credentials.json");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok", port: PORT }));

// ── Supported runtimes (mirrors main server) ───────────────────────────────────

const IMAGES = {
  nodejs:    "node:20-alpine",
  nodejs22:  "node:22.12.0-alpine",
  nodejs18:  "node:18-alpine",
  nodejs16:  "node:16-alpine",
  python:    "python:3.12-slim",
  python310: "python:3.10-slim",
  python39:  "python:3.9-slim",
  go:        "golang:1.22-alpine",
  go121:     "golang:1.21-alpine",
  ts:        "node:20-alpine",
  ts18:      "node:18-alpine",
  bun:       "oven/bun:latest",
  deno:      "denoland/deno:latest",
  php:       "php:8.3-cli-alpine",
};

// ── File helpers ───────────────────────────────────────────────────────────────

function readJSON(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (e) {
    console.error(`[io] Failed to read ${file}:`, e.message);
    return fallback;
  }
}

function writeJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    console.error(`[io] Failed to write ${file}:`, e.message);
    return false;
  }
}

function loadUserCredential(username) {
  return readJSON(CREDS_FILE, {})[username] ?? null;
}

// apps.json is now a flat array: [{ name, networking, status, password, packages, ... }, ...]
function readAppsFile() {
  return readJSON(APPS_FILE, []);
}

function writeAppsFile(apps) {
  return writeJSON(APPS_FILE, apps);
}

function findAppByName(appName) {
  const apps = readAppsFile();
  return apps.find(a => a.name === appName) ?? null;
}

// ── Auth helper ────────────────────────────────────────────────────────────────

function authConnection(msg, ws, send) {
  const { username, password, appName, appPassword } = msg;

  if (!username || !password || !appName || !appPassword) {
    send({ type: "error", message: "Missing credentials" });
    ws.close(1008, "Missing credentials");
    return null;
  }

  const userCred = loadUserCredential(username);
  if (!userCred || userCred.pass !== password) {
    send({ type: "error", message: "Invalid username or password" });
    ws.close(1008, "Auth failed");
    return null;
  }

  if (!(userCred.servers ?? []).includes(appName)) {
    send({ type: "error", message: "You don't own this app" });
    ws.close(1008, "Not owner");
    return null;
  }

  const appEntry = findAppByName(appName);
  if (!appEntry) {
    send({ type: "error", message: "App not found" });
    ws.close(1008, "App not found");
    return null;
  }

  if (appEntry.password !== appPassword) {
    send({ type: "error", message: "Invalid app password" });
    ws.close(1008, "Auth failed");
    return null;
  }

  const status = appEntry.status;
  if (status === "suspended" || status === "expired") {
    send({ type: "error", message: `Cannot exec: app is ${status}` });
    ws.close(1008, `App ${status}`);
    return null;
  }

  return { userCred, appEntry };
}

// ── Package command builder (mirrors main server) ──────────────────────────────

function buildPackageCommand(action, language, packages) {
  const pkgs = (packages || []).map(p => String(p).trim()).filter(Boolean);
  if (pkgs.length === 0) return null;
  const p = pkgs.join(" ");

  if (action === "install") {
    if (language.startsWith("nodejs") || language === "ts" || language.startsWith("ts"))
      return `cd /app && npm install --no-audit --no-fund --loglevel=warn ${p}`;
    if (language === "bun")
      return `cd /app && bun add ${p}`;
    if (language.startsWith("python"))
      return `cd /app && pip install --no-cache-dir --disable-pip-version-check ${p}`;
    if (language.startsWith("go"))
      return `cd /app && GOFLAGS=-mod=mod go get ${p}`;
    if (language === "php")
      return `cd /app && composer require --no-interaction --no-scripts --no-plugins ${p}`;
    return null;
  }

  if (action === "uninstall") {
    if (language.startsWith("nodejs") || language === "ts" || language.startsWith("ts"))
      return `cd /app && npm uninstall --no-audit --no-fund --loglevel=warn ${p}`;
    if (language === "bun")
      return `cd /app && bun remove ${p}`;
    if (language.startsWith("python"))
      return `cd /app && pip uninstall --disable-pip-version-check -y ${p}`;
    if (language === "php")
      return `cd /app && composer remove --no-interaction --no-scripts --no-plugins ${p}`;
    return null;
  }

  return null;
}

// ── Package list persistence (per-app packages array in apps.json) ─────────────

// Strip version/registry specifiers so "lodash@4.17.21", "lodash@^4", etc.
// all normalize to "lodash" for dedupe/removal purposes.
function normalizePackageName(p) {
  let name = String(p).trim();
  if (name.startsWith("@")) {
    // scoped npm package: @scope/name@version -> @scope/name
    const parts = name.split("@");
    name = "@" + (parts[1] || "");
  } else {
    name = name.split("@")[0];
  }
  return name.trim();
}

function persistPackages(username, appName, action, packages) {
  const incoming = (packages || []).map(normalizePackageName).filter(Boolean);
  if (incoming.length === 0) return;

  const allApps = readAppsFile();
  const entry   = allApps.find(a => a.name === appName);
  if (!entry) return;

  const current = Array.isArray(entry.packages) ? entry.packages : [];

  let updated;
  if (action === "install") {
    const set = new Set(current.map(normalizePackageName));
    incoming.forEach(p => set.add(p));
    updated = Array.from(set);
  } else {
    // uninstall — remove any current entries that normalize to one of the
    // packages we just uninstalled
    const removeSet = new Set(incoming);
    updated = current.filter(p => !removeSet.has(normalizePackageName(p)));
  }

  entry.packages = updated;
  writeAppsFile(allApps);
  console.log(`[exec] packages for ${username}:${appName} -> [${updated.join(", ")}]`);
}

// ── Active terminal sessions (one per username:appName, always replaced fresh) ─

const sessions = new Map();

function sessionKey(username, appName) {
  return `${username}:${appName}`;
}

// ── Mode: terminal ─────────────────────────────────────────────────────────────

function handleTerminal(ws, msg) {
  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };

  const { username, appName } = msg;
  const result = authConnection(msg, ws, send);
  if (!result) return;

  const key = sessionKey(username, appName);

  if (sessions.has(key)) {
    const oldEntry = sessions.get(key);
    console.log(`[terminal] Existing session ${key} found — killing it before starting fresh`);
    try { oldEntry.ptyProc.kill(); } catch (_) {}
    sessions.delete(key);
  }

  let ptyProc;
  try {
    ptyProc = pty.spawn("docker", ["exec", "-it", appName, "/bin/sh"], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      env: { ...process.env, TERM: "xterm-256color" },
    });
  } catch (err) {
    send({ type: "error", message: "Failed to spawn terminal: " + err.message });
    return ws.close(1011, "Spawn failed");
  }

  const sessionEntry = { ptyProc, ws };
  sessions.set(key, sessionEntry);

  ptyProc.onData((chunk) => {
    if (sessionEntry.ws?.readyState === sessionEntry.ws?.OPEN)
      sessionEntry.ws.send(JSON.stringify({ type: "output", data: chunk }));
  });

  ptyProc.onExit(({ exitCode }) => {
    console.log(`[terminal] PTY exited for ${key} (code ${exitCode})`);
    if (sessionEntry.ws?.readyState === sessionEntry.ws?.OPEN) {
      sessionEntry.ws.send(JSON.stringify({ type: "exit", code: exitCode }));
      sessionEntry.ws.close();
    }
    // Only remove from the map if this entry is still the current one for
    // this key (it may have already been replaced by a newer session).
    if (sessions.get(key) === sessionEntry) sessions.delete(key);
  });

  send({ type: "ready", message: `Connected to ${appName}` });
  console.log(`[terminal] New session ${key}`);
  bindTerminalMessages(ws, send, sessionEntry, key);
}

function bindTerminalMessages(ws, send, sessionEntry, key) {
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === "input")  sessionEntry.ptyProc.write(msg.data ?? "");
    if (msg.type === "resize") {
      const cols = Math.max(1, parseInt(msg.cols) || 80);
      const rows = Math.max(1, parseInt(msg.rows) || 24);
      try { sessionEntry.ptyProc.resize(cols, rows); } catch (_) {}
    }
  });

  const cleanup = () => {
    try { sessionEntry.ptyProc.kill(); } catch (_) {}
    if (sessions.get(key) === sessionEntry) sessions.delete(key);
    console.log(`[terminal] WS closed for ${key}, session killed`);
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
}

// ── Mode: logs ─────────────────────────────────────────────────────────────────

function handleLogs(ws, msg) {
  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };

  const { appName } = msg;
  const result = authConnection(msg, ws, send);
  if (!result) return;

  let logProc;
  try {
    logProc = spawn("docker", ["logs", "--follow", "--timestamps", appName],
      { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    send({ type: "error", message: "Failed to stream logs: " + err.message });
    return ws.close(1011, "Spawn failed");
  }

  const onData = (chunk) => send({ type: "log", data: chunk.toString() });
  logProc.stdout.on("data", onData);
  logProc.stderr.on("data", onData);
  logProc.on("exit",  (code) => { send({ type: "exit", code }); ws.close(); });
  logProc.on("error", (err)  => { send({ type: "error", message: err.message }); ws.close(1011, "Process error"); });

  const cleanup = () => { try { logProc.kill(); } catch (_) {} };
  ws.on("close", cleanup);
  ws.on("error", cleanup);

  send({ type: "ready", message: `Streaming logs for ${appName}` });
  console.log(`[logs] Streaming logs for ${appName}`);
}

// ── Mode: specs ────────────────────────────────────────────────────────────────

function handleSpecs(ws, msg) {
  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };

  const { appName } = msg;
  const result = authConnection(msg, ws, send);
  if (!result) return;

  let statsProc;
  try {
    statsProc = spawn("docker", [
      "stats", appName, "--no-trunc", "--format",
      '{"cpu":"{{.CPUPerc}}","mem_usage":"{{.MemUsage}}","mem_perc":"{{.MemPerc}}","net_io":"{{.NetIO}}","block_io":"{{.BlockIO}}","pids":"{{.PIDs}}"}'
    ], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    send({ type: "error", message: "Failed to stream stats: " + err.message });
    return ws.close(1011, "Spawn failed");
  }

  let buffer = "";
  const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\r/g;

  statsProc.stdout.on("data", (chunk) => {
    buffer += chunk.toString().replace(ANSI_RE, "");
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { send({ type: "stats", data: JSON.parse(trimmed) }); } catch (_) {}
    }
  });

  statsProc.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) send({ type: "error", message: text });
  });

  statsProc.on("exit",  (code) => { send({ type: "exit", code }); ws.close(); });
  statsProc.on("error", (err)  => { send({ type: "error", message: err.message }); ws.close(1011, "Process error"); });

  const cleanup = () => { try { statsProc.kill(); } catch (_) {} };
  ws.on("close", cleanup);
  ws.on("error", cleanup);

  send({ type: "ready", message: `Streaming specs for ${appName}` });
  console.log(`[specs] Streaming specs for ${appName}`);
}

// ── Mode: exec ─────────────────────────────────────────────────────────────────
// First message: { mode: "exec", username, password, appName, appPassword, language, action, packages }
//
// Messages sent to client:
//   { type: "ready",  message: "..." }           — auth ok, starting
//   { type: "output", data: "<chunk>" }           — live stdout/stderr lines
//   { type: "done",   exitCode: 0 }               — finished successfully
//   { type: "error",  message: "..." }             — fatal error

function handleExec(ws, msg) {
  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };

  const { language, action, packages } = msg;

  // Validate language & action before auth to give clear errors
  if (!language || !IMAGES[language]) {
    send({ type: "error", message: `Unsupported runtime: ${language}` });
    return ws.close(1008, "Bad language");
  }

  if (action !== "install" && action !== "uninstall") {
    send({ type: "error", message: "action must be 'install' or 'uninstall'" });
    return ws.close(1008, "Bad action");
  }

  const result = authConnection(msg, ws, send);
  if (!result) return;

  const { username, appName } = msg;

  const command = buildPackageCommand(action, language, packages);
  if (!command) {
    send({ type: "error", message: `No ${action} command available for runtime '${language}' (did you pass packages?)` });
    return ws.close(1008, "No command");
  }

  send({ type: "ready", message: `Running ${action} on ${appName}…` });
  console.log(`[exec] ${action} on ${appName} | lang=${language} | pkgs=${(packages||[]).join(",")}`);

  let proc;
  try {
    proc = spawn("docker", ["exec", appName, "/bin/sh", "-c", command], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    send({ type: "error", message: "Failed to spawn process: " + err.message });
    return ws.close(1011, "Spawn failed");
  }

  const onData = (chunk) => send({ type: "output", data: chunk.toString() });
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);

  proc.on("exit", (code) => {
    console.log(`[exec] Done on ${appName} (code ${code})`);
    const exitCode = code ?? 0;

    // Only mutate the stored package list if the command actually succeeded
    if (exitCode === 0) {
      persistPackages(username, appName, action, packages);
    }

    send({ type: "done", exitCode });
    ws.close();
  });

  proc.on("error", (err) => {
    send({ type: "error", message: "Process error: " + err.message });
    ws.close(1011, "Process error");
  });

  // If client disconnects early, kill the process
  const cleanup = () => { try { proc.kill(); } catch (_) {} };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
}

// ── Main WS entry point ────────────────────────────────────────────────────────

wss.on("connection", (ws) => {
  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };

  ws.once("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { return ws.close(1008, "Invalid JSON"); }

    const { mode } = msg;

    if (!mode) {
      send({ type: "error", message: "Missing 'mode' field. Expected: terminal | logs | specs | exec" });
      return ws.close(1008, "Missing mode");
    }

    switch (mode) {
      case "terminal": return handleTerminal(ws, msg);
      case "logs":     return handleLogs(ws, msg);
      case "specs":    return handleSpecs(ws, msg);
      case "exec":     return handleExec(ws, msg);
      default:
        send({ type: "error", message: `Unknown mode "${mode}". Expected: terminal | logs | specs | exec` });
        return ws.close(1008, "Unknown mode");
    }
  });
});

// ── Start ──────────────────────────────────────────────────────────────────────

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n[ws-server] Listening on port ${PORT}`);
  console.log(`[ws-server] WebSocket: ws://0.0.0.0:${PORT}`);
  console.log(`[ws-server] Health:    http://0.0.0.0:${PORT}/health`);
  console.log(`[ws-server] Modes:     terminal | logs | specs | exec\n`);
});