// src/config.js
const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_DIR = path.join(os.homedir(), ".nyxo");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const HISTORY_FILE = path.join(CONFIG_DIR, "history.json");
const RECALL_FILE = path.join(CONFIG_DIR, "recall.txt");

function ensureDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function loadConfig() {
  ensureDir();
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  ensureDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function getApiKey() {
  return process.env.NYXO_API_KEY || loadConfig().apiKey || null;
}

function getModelKey() {
  return process.env.NYXO_MODEL || loadConfig().modelKey || null;
}

function getWorkerUrl() {
  return process.env.NYXO_WORKER_URL || loadConfig().workerUrl || null;
}

function setApiKey(key) {
  const cfg = loadConfig();
  cfg.apiKey = key;
  saveConfig(cfg);
}

function setModelKey(key) {
  const cfg = loadConfig();
  cfg.modelKey = key;
  saveConfig(cfg);
}

function setWorkerUrl(url) {
  const cfg = loadConfig();
  cfg.workerUrl = url;
  saveConfig(cfg);
}

function getConfigPath() {
  return CONFIG_FILE;
}

function getHistoryPath() {
  return HISTORY_FILE;
}

function getRecallPath() {
  return RECALL_FILE;
}

// ─── recall.txt helpers ───────────────────────────────────────────────────────

/**
 * Load recall.txt contents. Returns empty string if file doesn't exist.
 */
function loadRecall() {
  ensureDir();
  if (!fs.existsSync(RECALL_FILE)) return "";
  try {
    return fs.readFileSync(RECALL_FILE, "utf-8").trim();
  } catch {
    return "";
  }
}

/**
 * Overwrite recall.txt with new content.
 */
function saveRecall(content) {
  ensureDir();
  fs.writeFileSync(RECALL_FILE, content.trim() + "\n", "utf-8");
}

/**
 * Append a new key=value line to recall.txt if key doesn't already exist.
 */
function upsertRecall(key, value) {
  ensureDir();
  let lines = [];
  if (fs.existsSync(RECALL_FILE)) {
    lines = fs.readFileSync(RECALL_FILE, "utf-8").split("\n").filter(Boolean);
  }
  const prefix = `${key}=`;
  const idx = lines.findIndex((l) => l.startsWith(prefix));
  const entry = `${key}=${value}`;
  if (idx >= 0) {
    lines[idx] = entry;
  } else {
    lines.push(entry);
  }
  fs.writeFileSync(RECALL_FILE, lines.join("\n") + "\n", "utf-8");
}

// ─── skills.txt helpers ───────────────────────────────────────────────────────

/**
 * Looks for skills.txt in CWD first, then ~/.nyxo/skills.txt.
 * Returns contents or empty string.
 */
function loadSkills() {
  const localSkills = path.join(process.cwd(), "skills.txt");
  if (fs.existsSync(localSkills)) {
    try {
      return fs.readFileSync(localSkills, "utf-8").trim();
    } catch {
      return "";
    }
  }
  const globalSkills = path.join(CONFIG_DIR, "skills.txt");
  if (fs.existsSync(globalSkills)) {
    try {
      return fs.readFileSync(globalSkills, "utf-8").trim();
    } catch {
      return "";
    }
  }
  return "";
}

module.exports = {
  loadConfig,
  saveConfig,
  getApiKey,
  getModelKey,
  getWorkerUrl,
  setApiKey,
  setModelKey,
  setWorkerUrl,
  getConfigPath,
  getHistoryPath,
  getRecallPath,
  loadRecall,
  saveRecall,
  upsertRecall,
  loadSkills,
  CONFIG_DIR,
};
