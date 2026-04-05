// src/mcp.js
/**
 * MCP (Model Context Protocol) Client
 * Connects to external tool servers over WebSocket or HTTP,
 * discovers their tools, and executes tool calls on behalf of the agent.
 *
 * Config file locations (checked in order):
 *   1. ./mcp_config.json  (project-local)
 *   2. ~/.nyxo/mcp_config.json  (global)
 *
 * Config format:
 * {
 *   "servers": [
 *     { "name": "filesystem", "transport": "ws",   "url": "ws://localhost:3001" },
 *     { "name": "browser",    "transport": "ws",   "url": "ws://localhost:3002", "disabled": true },
 *     { "name": "crypto",     "transport": "http", "url": "https://mcp.cryptoapi.com" }
 *   ]
 * }
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const axios = require("axios");

// ws is optional — only needed for WebSocket transport
let WebSocket;
try { WebSocket = require("ws"); } catch (_) { WebSocket = null; }

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG_SEARCH = [
  path.join(process.cwd(), "mcp_config.json"),
  path.join(process.env.HOME || process.env.USERPROFILE || "", ".nyxo", "mcp_config.json"),
];

function loadMcpConfig() {
  for (const loc of CONFIG_SEARCH) {
    if (fs.existsSync(loc)) {
      try {
        const config = JSON.parse(fs.readFileSync(loc, "utf-8"));
        return { filePath: loc, servers: config.servers || [] };
      } catch (e) {
        return { filePath: loc, servers: [], parseError: e.message };
      }
    }
  }
  return null; // no config file found
}

// ─── WebSocket Client ─────────────────────────────────────────────────────────

class WsClient {
  constructor(name, url) {
    this.name      = name;
    this.url       = url;
    this.ws        = null;
    this.pending   = new Map(); // id → { resolve, reject }
    this._id       = 1;
    this.tools     = [];
    this.connected = false;
  }

  async connect() {
    if (!WebSocket) {
      throw new Error(
        `"ws" package not installed. Fix: npm install ws  (needed for WebSocket MCP servers)`
      );
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);

      const timeout = setTimeout(() => {
        ws.terminate();
        reject(new Error(`Timeout connecting to ${this.url}`));
      }, 8000);

      ws.on("open", () => {
        clearTimeout(timeout);
        this.ws        = ws;
        this.connected = true;
        resolve();
      });

      ws.on("error", (e) => {
        clearTimeout(timeout);
        reject(new Error(`${this.name}: ${e.message}`));
      });

      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          // Only handle responses (have an id), ignore server notifications
          if (msg.id != null && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else           resolve(msg.result);
          }
        } catch (_) {}
      });

      ws.on("close", () => {
        this.connected = false;
        // Reject any still-pending requests
        for (const [, { reject }] of this.pending) {
          reject(new Error(`${this.name}: connection closed`));
        }
        this.pending.clear();
      });
    });
  }

  async request(method, params = {}) {
    if (!this.connected) throw new Error(`${this.name}: not connected`);
    const id = this._id++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name}: timeout on ${method}`));
      }, 15000);

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject:  (e) => { clearTimeout(timer); reject(e);  },
      });

      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  // Fire-and-forget notification (no response expected)
  notify(method, params = {}) {
    if (!this.connected) return;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  close() {
    if (this.ws) this.ws.close();
    this.connected = false;
  }
}

// ─── HTTP Client ──────────────────────────────────────────────────────────────

class HttpClient {
  constructor(name, url) {
    this.name      = name;
    this.url       = url;
    this._id       = 1;
    this.tools     = [];
    this.connected = false;
  }

  async connect() {
    // HTTP is stateless — no persistent connection needed
    this.connected = true;
  }

  async request(method, params = {}) {
    const id  = this._id++;
    const res = await axios.post(
      this.url,
      { jsonrpc: "2.0", id, method, params },
      { headers: { "Content-Type": "application/json" }, timeout: 15000 }
    );
    const data = res.data;
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    return data.result;
  }

  // HTTP has no persistent connection, nothing to close
  close() { this.connected = false; }
}

// ─── State ────────────────────────────────────────────────────────────────────

/** @type {Map<string, WsClient|HttpClient>} */
const _clients = new Map();
let _initialized = false;

// ─── Server Init ──────────────────────────────────────────────────────────────

async function initServer(serverConf) {
  const { name, transport, url } = serverConf;

  const client = (transport === "ws")
    ? new WsClient(name, url)
    : new HttpClient(name, url);

  await client.connect();

  // MCP handshake: initialize
  await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities:    { tools: {} },
    clientInfo:      { name: "nyxo-code", version: "1.0.0" },
  });

  // MCP handshake: initialized notification (required by spec)
  if (typeof client.notify === "function") {
    client.notify("notifications/initialized");
  }

  // Discover tools this server exposes
  const result  = await client.request("tools/list", {});
  client.tools  = result?.tools || [];

  return client;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialize all enabled MCP servers from config.
 * Call once at startup.
 * @param {object} ui - ui module (for printing status), can be null
 * @returns {{ loaded: boolean, connected: number, total: number, configPath: string }}
 */
async function initMcp(ui) {
  const config = loadMcpConfig();

  if (!config) {
    return { loaded: false }; // no mcp_config.json, that's fine
  }

  if (config.parseError) {
    if (ui) ui.printWarning(`MCP: failed to parse ${config.filePath} — ${config.parseError}`);
    return { loaded: false };
  }

  const enabled = config.servers.filter(s => !s.disabled);
  if (!enabled.length) {
    return { loaded: true, connected: 0, total: 0, configPath: config.filePath };
  }

  let connected = 0;

  for (const serverConf of enabled) {
    try {
      const client = await initServer(serverConf);
      _clients.set(serverConf.name, client);
      connected++;
      if (ui) {
        ui.printSuccess(`MCP ◉ "${serverConf.name}" connected — ${client.tools.length} tool(s)`);
      }
    } catch (e) {
      if (ui) {
        ui.printWarning(`MCP ✗ "${serverConf.name}" failed — ${e.message}`);
      }
    }
  }

  _initialized = true;
  return { loaded: true, connected, total: enabled.length, configPath: config.filePath };
}

/**
 * Returns a schema string describing all MCP tools.
 * Appended to the AI's system prompt dynamically.
 */
function getMcpToolSchema() {
  if (!_initialized || _clients.size === 0) return "";

  const lines = [];

  for (const [serverName, client] of _clients) {
    if (!client.connected || !client.tools.length) continue;

    lines.push(`\nMCP Server "${serverName}":`);

    for (const tool of client.tools) {
      const desc   = tool.description ? ` → ${tool.description}` : "";
      const schema = tool.inputSchema?.properties || {};
      const req    = tool.inputSchema?.required   || [];
      const params = Object.keys(schema)
        .map(k => req.includes(k) ? k : `${k}?`)
        .join(", ");

      lines.push(`  - mcp__${serverName}__${tool.name}(${params})${desc}`);
    }
  }

  if (!lines.length) return "";

  return (
    "\n\nMCP TOOLS (from connected external servers):" +
    lines.join("\n") +
    '\n\nCall MCP tools exactly like built-in tools: { "tool": "mcp__serverName__toolName", "args": { ... } }'
  );
}

/**
 * Execute a tool on an MCP server.
 * @param {string} serverName
 * @param {string} toolName
 * @param {object} args
 * @returns {Promise<string>} human-readable result
 */
async function executeMcpTool(serverName, toolName, args) {
  const client = _clients.get(serverName);
  if (!client)            return `Error: MCP server "${serverName}" is not connected.`;
  if (!client.connected)  return `Error: MCP server "${serverName}" disconnected.`;

  try {
    const result = await client.request("tools/call", {
      name:      toolName,
      arguments: args,
    });

    // MCP returns: { content: [{ type: "text", text: "..." }, ...], isError?: boolean }
    if (result?.isError) {
      const errText = (result.content || [])
        .filter(c => c.type === "text")
        .map(c => c.text)
        .join("\n");
      return `Error from ${serverName}/${toolName}: ${errText || "unknown error"}`;
    }

    if (Array.isArray(result?.content)) {
      return result.content
        .filter(c => c.type === "text")
        .map(c => c.text)
        .join("\n") || "(empty result)";
    }

    // Fallback for non-standard shapes
    return typeof result === "string" ? result : JSON.stringify(result, null, 2);

  } catch (e) {
    return `Error calling ${serverName}/${toolName}: ${e.message}`;
  }
}

/**
 * Returns status of all connected MCP servers.
 */
function getMcpStatus() {
  return [..._clients.entries()].map(([name, client]) => ({
    name,
    connected: client.connected,
    toolCount: client.tools.length,
    tools:     client.tools.map(t => t.name),
  }));
}

/**
 * Close all MCP connections cleanly.
 */
function disconnectAll() {
  for (const client of _clients.values()) client.close();
  _clients.clear();
  _initialized = false;
}

module.exports = {
  initMcp,
  getMcpToolSchema,
  executeMcpTool,
  getMcpStatus,
  disconnectAll,
};
