// src/config.js
const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_DIR = path.join(os.homedir(), ".nyxo");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const HISTORY_FILE = path.join(CONFIG_DIR, "history.json");

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

function getConfigPath() {
  return CONFIG_FILE;
}

function getHistoryPath() {
  return HISTORY_FILE;
}

module.exports = {
  loadConfig,
  saveConfig,
  getApiKey,
  getModelKey,
  setApiKey,
  setModelKey,
  getConfigPath,
  getHistoryPath,
  CONFIG_DIR,
};
