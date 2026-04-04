// src/history.js
const fs = require("fs");
const { getHistoryPath } = require("./config");

const MAX_PERSISTENT_SESSIONS = 50;
const MAX_ACTIONS_PER_SESSION = 200;

// ─── In-Memory Session ────────────────────────────────────────────────────────

let sessionId = null;
let conversationTurns = []; // [{role, content}]
let actionLog = [];         // [{type, detail, ts}]

function startSession(modelKey) {
  sessionId = `${Date.now()}`;
  conversationTurns = [];
  actionLog = [];
  logAction("session_start", `Model: ${modelKey}`);
  return sessionId;
}

function addTurn(role, content) {
  conversationTurns.push({ role, content });
}

function getTurns() {
  return conversationTurns;
}

function logAction(type, detail) {
  actionLog.push({
    type,
    detail: String(detail).slice(0, 300),
    ts: new Date().toISOString(),
  });
  if (actionLog.length > MAX_ACTIONS_PER_SESSION) actionLog.shift();
}

function getActionLog() {
  return actionLog;
}

// ─── Persistent History ───────────────────────────────────────────────────────

function loadPersistentHistory() {
  const p = getHistoryPath();
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return [];
  }
}

function saveSession(userFirstMessage) {
  if (!sessionId || conversationTurns.length === 0) return;

  const sessions = loadPersistentHistory();
  sessions.unshift({
    id: sessionId,
    date: new Date().toISOString(),
    title: userFirstMessage.slice(0, 80),
    turns: conversationTurns.length,
    actions: actionLog.length,
    actionLog: actionLog.slice(0, 30),
  });

  // Keep only last N sessions
  const trimmed = sessions.slice(0, MAX_PERSISTENT_SESSIONS);
  fs.writeFileSync(getHistoryPath(), JSON.stringify(trimmed, null, 2));
}

function clearHistory() {
  const p = getHistoryPath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

module.exports = {
  startSession,
  addTurn,
  getTurns,
  logAction,
  getActionLog,
  loadPersistentHistory,
  saveSession,
  clearHistory,
};
