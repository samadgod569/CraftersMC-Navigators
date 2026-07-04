const express = require("express");
const http = require("http");
const fs = require("fs");
const net = require("net");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();
const server = http.createServer(app);

// ── Platform config ─────────────────────────────────────────────────────
const PLATFORM_NAME = "DockHive";
const PLATFORM_DOMAIN = "code-mon-space.shop"; // temp domain
const PLATFORM_URL = `https://${PLATFORM_DOMAIN}`;
const MAIN_APP_TARGET = "103.20.230.5:3000"; // ip:port for the main dashboard/homepage
const ROUTER_PORT = 5000;

const APPS_PATH = "/platform/data/apps.json";
const CREDS_PATH = "/platform/data/credentials.json";
const API_BASE = "https://pylex.cloud";

function splitIpPort(value) {
  if (!value) return { host: null, port: null };
  const str = String(value).trim();
  const idx = str.lastIndexOf(":");
  if (idx === -1) return { host: str, port: null };
  return { host: str.slice(0, idx), port: Number(str.slice(idx + 1)) };
}

const { host: MAIN_APP_HOST, port: MAIN_APP_PORT } = splitIpPort(MAIN_APP_TARGET);

/**
 * Loads apps.json, which is now a flat array of app entries:
 * [
 *   {
 *     "name": "whsjs",
 *     "networking": [{ "ip": "1.2.3.4:38281", "subdomain": "app1", "domain": "domain.com" }],
 *     ...other app data (status, blocked, errors, password, "web-proxy", etc.)
 *   },
 *   ...
 * ]
 */
function loadAllApps() {
  try {
    if (!fs.existsSync(APPS_PATH)) return [];
    const raw = JSON.parse(fs.readFileSync(APPS_PATH, "utf-8"));
    if (!Array.isArray(raw)) return [];
    return raw;
  } catch (e) {
    console.error("[apps.json] Read failed:", e.message);
    return [];
  }
}

function loadCredentials() {
  try {
    if (!fs.existsSync(CREDS_PATH)) return {};
    return JSON.parse(fs.readFileSync(CREDS_PATH, "utf-8"));
  } catch (e) {
    console.error("[credentials.json] Read failed:", e.message);
    return {};
  }
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress || "";
}

const ICONS = {
  warning:  `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><circle cx="12" cy="17" r="0.6" fill="currentColor"/></svg>`,
  offline:  `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>`,
  lock:     `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  sleep:    `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
  clock:    `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  stop:     `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><rect x="9" y="9" width="6" height="6" fill="currentColor" stroke="none"/></svg>`,
  bug:      `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2l1.5 1.5"/><path d="M14.5 3.5L16 2"/><path d="M9 9H5"/><path d="M19 9h-4"/><path d="M9 15H5"/><path d="M19 15h-4"/><path d="M8 21l1-1"/><path d="M15 20l1 1"/><rect x="8" y="6" width="8" height="14" rx="4"/></svg>`,
  question: `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><circle cx="12" cy="17" r="0.6" fill="currentColor"/></svg>`,
  wrench:   `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`,
  notfound: `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>`,
  error:    `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><circle cx="12" cy="16" r="0.6" fill="currentColor"/></svg>`,
};

/**
 * Builds the default DockHive error page — purple & white theme,
 * with automatic dark/light mode support (prefers-color-scheme) plus a
 * manual toggle that persists via a small inline script (no localStorage,
 * just a data-attribute the user can flip during the session).
 */
function buildDefaultErrorHtml(statusCode, title, message, iconKey = "warning") {
  const svgIcon = ICONS[iconKey] || ICONS.warning;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} | ${PLATFORM_NAME}</title>
  <style>
    :root{
      --purple: #7c3aed;
      --purple-dark: #6d28d9;
      --purple-light: #a78bfa;
      --bg: #ffffff;
      --bg-alt: #f5f3ff;
      --text: #1e1b2e;
      --text-muted: #6b6478;
      --card-border: rgba(124,58,237,0.18);
      --icon-bg: rgba(124,58,237,0.08);
    }
    @media (prefers-color-scheme: dark){
      :root{
        --bg: #14101f;
        --bg-alt: #1c1730;
        --text: #f5f3ff;
        --text-muted: #a79fc0;
        --card-border: rgba(167,139,250,0.25);
        --icon-bg: rgba(167,139,250,0.12);
      }
    }
    html[data-theme="dark"]{
      --bg: #14101f;
      --bg-alt: #1c1730;
      --text: #f5f3ff;
      --text-muted: #a79fc0;
      --card-border: rgba(167,139,250,0.25);
      --icon-bg: rgba(167,139,250,0.12);
    }
    html[data-theme="light"]{
      --bg: #ffffff;
      --bg-alt: #f5f3ff;
      --text: #1e1b2e;
      --text-muted: #6b6478;
      --card-border: rgba(124,58,237,0.18);
      --icon-bg: rgba(124,58,237,0.08);
    }
    *{margin:0;padding:0;box-sizing:border-box;}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:linear-gradient(135deg,var(--bg) 0%,var(--bg-alt) 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;color:var(--text);transition:background 0.2s,color 0.2s;}
    .c{max-width:550px;text-align:center;animation:fi 0.5s ease-out;}
    @keyframes fi{from{opacity:0;transform:translateY(-20px);}to{opacity:1;transform:translateY(0);}}
    .ic{width:100px;height:100px;background:var(--icon-bg);border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 25px;border:2px solid var(--card-border);color:var(--purple);}
    h1{color:var(--text);font-size:2rem;margin-bottom:15px;font-weight:700;}
    .ec{background:var(--icon-bg);color:var(--purple);padding:5px 15px;border-radius:20px;font-family:monospace;font-size:0.85rem;display:inline-block;margin-bottom:20px;border:1px solid var(--card-border);}
    p{color:var(--text-muted);font-size:1rem;line-height:1.6;margin-bottom:30px;}
    .btn{display:inline-block;padding:12px 32px;background:var(--purple);color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:0.9rem;transition:all 0.2s;}
    .btn:hover{background:var(--purple-dark);transform:translateY(-2px);box-shadow:0 5px 20px rgba(124,58,237,0.35);}
    .ft{margin-top:40px;font-size:0.75rem;color:var(--text-muted);}
    .ft a{color:var(--purple);text-decoration:none;}
    .theme-toggle{position:fixed;top:20px;right:20px;background:var(--icon-bg);border:1px solid var(--card-border);color:var(--purple);border-radius:20px;padding:8px 16px;font-size:0.8rem;font-weight:600;cursor:pointer;font-family:inherit;}
    .theme-toggle:hover{background:var(--purple);color:#fff;}
  </style>
</head>
<body>
  <button class="theme-toggle" onclick="toggleTheme()">Toggle theme</button>
  <div class="c">
    <div class="ic">${svgIcon}</div>
    <div class="ec">${statusCode}</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <a href="${PLATFORM_URL}" class="btn">Go to Dashboard</a>
    <div class="ft"><a href="${PLATFORM_URL}">${PLATFORM_NAME}</a> • Premium Hosting Platform</div>
  </div>
  <script>
    function applyStoredTheme(){
      var t = null;
      try { t = window.__dockhiveTheme || null; } catch(e){}
      if (t) document.documentElement.setAttribute('data-theme', t);
    }
    function toggleTheme(){
      var current = document.documentElement.getAttribute('data-theme');
      var isDark = current ? current === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
      var next = isDark ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      window.__dockhiveTheme = next;
    }
    applyStoredTheme();
  </script>
</body>
</html>`;
}

// Status codes that support custom user-defined error pages
const CUSTOM_ERROR_CODES = ["403", "500", "502", "503", "504"];

/**
 * Fetches a custom error page's content via /api/fs/read for the given app,
 * using the file path the owner assigned to this error code.
 * Returns the file content string, or null if unavailable / should fall back.
 */
async function fetchCustomErrorPage(matchedApp, statusCode) {
  try {
    if (!matchedApp) return null;

    const errors = matchedApp.errors;
    if (!errors || typeof errors !== "object") return null;

    const filePath = errors[String(statusCode)];
    if (!filePath || typeof filePath !== "string" || filePath.trim() === "") return null;

    const creds = loadCredentials();
    const username = matchedApp.username;
    const userCred = username ? creds[username] : null;
    if (!userCred) return null;

    const password = userCred.pass;
    const appName = matchedApp.name;
    const appPassword = matchedApp.password;

    const resp = await fetch(`${API_BASE}/api/fs/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, appName, appPassword, filePath })
    });

    if (!resp.ok) return null;

    const json = await resp.json();
    if (json.status !== "success" || typeof json.content !== "string") return null;

    return json.content;
  } catch (e) {
    console.error(`[custom-error:${statusCode}] fetch failed:`, e.message);
    return null;
  }
}

/**
 * Sends an error page for the given status code. If the matched app has a
 * custom error page configured for this status code, that content is served
 * (always with text/html mime, regardless of the actual file type).
 * Otherwise falls back to the default DockHive-styled error page.
 */
async function sendErrorPage(res, statusCode, title, message, iconKey = "warning", matchedApp = null) {
  if (CUSTOM_ERROR_CODES.includes(String(statusCode))) {
    const customContent = await fetchCustomErrorPage(matchedApp, statusCode);
    if (customContent !== null) {
      res.status(statusCode).set("Content-Type", "text/html").send(customContent);
      return;
    }
  }

  const html = buildDefaultErrorHtml(statusCode, title, message, iconKey);
  res.status(statusCode).send(html);
}

function createAppProxy(targetHost, targetPort, label, matchedApp) {
  return createProxyMiddleware({
    target: `http://${targetHost}:${targetPort}`,
    changeOrigin: true,
    ws: false,
    xfwd: true,
    proxyTimeout: 30000,
    timeout: 30000,
    on: {
      error: (err, req, res) => {
        console.error(`[proxy:${label}] error:`, err.message);
        if (res && typeof res.headersSent !== "undefined" && !res.headersSent) {
          sendErrorPage(res, 502, "Application Offline",
            "The application is currently not responding. It may be starting up or has crashed.", "offline", matchedApp);
        }
      },
    },
  });
}

const mainProxy = createProxyMiddleware({
  target: `http://${MAIN_APP_HOST}:${MAIN_APP_PORT}`,
  changeOrigin: true,
  ws: false,
  xfwd: true,
  proxyTimeout: 30000,
  timeout: 30000,
  on: {
    error: (err, req, res) => {
      console.error(`[proxy:main] error:`, err.message);
      if (res && typeof res.headersSent !== "undefined" && !res.headersSent) {
        sendErrorPage(res, 503, "Platform Maintenance",
          `${PLATFORM_NAME} is currently under maintenance. Please check back in a few minutes.`, "wrench");
      }
    },
  },
});

function isPortReachable(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1500);
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.on("error", () => { socket.destroy(); resolve(false); });
    socket.connect(port, host);
  });
}

/**
 * Given a hostname (already lowercased, port stripped), find which app
 * — and which specific networking entry on that app — should handle it.
 *
 * Matching rules:
 *  - If the host matches a networking entry's custom "domain" exactly, use it.
 *  - Otherwise, if the host's leftmost label matches a networking entry's
 *    "subdomain" (e.g. "app1" in "app1.code-mon-space.shop"), use it.
 *
 * Returns { app, networkEntry } or null if nothing matches.
 */
function resolveAppFromHost(cleanHost) {
  if (cleanHost === PLATFORM_DOMAIN || cleanHost === `www.${PLATFORM_DOMAIN}`) return null;

  const apps = loadAllApps();
  const firstLabel = cleanHost.split(".")[0];

  // 1) Exact custom-domain match takes priority
  for (const a of apps) {
    const nets = Array.isArray(a.networking) ? a.networking : [];
    for (const n of nets) {
      if (n.domain && String(n.domain).toLowerCase() === cleanHost) {
        return { app: a, networkEntry: n };
      }
    }
  }

  // 2) Subdomain match against our platform domain
  for (const a of apps) {
    const nets = Array.isArray(a.networking) ? a.networking : [];
    for (const n of nets) {
      if (n.subdomain && String(n.subdomain).toLowerCase() === firstLabel) {
        return { app: a, networkEntry: n };
      }
    }
  }

  return null;
}

function proxyWs(req, socket, head, targetHost, targetPort, label) {
  const httpProxy = require("http-proxy").createProxyServer({});

  socket.on("error", (err) => {
    console.error(`[ws:${label}] client socket error:`, err.message);
  });

  httpProxy.on("error", (err, req, socket) => {
    console.error(`[ws:${label}] proxy error:`, err.message);
    if (socket && socket.writable) {
      socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      socket.destroy();
    }
  });

  httpProxy.ws(req, socket, head, {
    target: `ws://${targetHost}:${targetPort}`,
    changeOrigin: true,
  });
}

server.on("upgrade", async (req, socket, head) => {
  const host = (req.headers.host || "").split(":")[0].toLowerCase().trim();
  console.log(`[ws:upgrade] ${host} ${req.url}`);

  socket.on("error", (err) => {
    console.error(`[ws:upgrade] socket error for ${host}:`, err.message);
  });

  if (host === PLATFORM_DOMAIN || host === `www.${PLATFORM_DOMAIN}`) {
    const reachable = await isPortReachable(MAIN_APP_HOST, MAIN_APP_PORT);
    if (!reachable) {
      console.warn(`[ws:upgrade] main app ${MAIN_APP_HOST}:${MAIN_APP_PORT} not reachable`);
      socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      socket.destroy();
      return;
    }
    return proxyWs(req, socket, head, MAIN_APP_HOST, MAIN_APP_PORT, "main");
  }

  const match = resolveAppFromHost(host);

  if (!match) {
    console.warn(`[ws:upgrade] no app found for: ${host}`);
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  const { app: matchedApp, networkEntry } = match;

  if (matchedApp.status !== "active") {
    console.warn(`[ws:upgrade] app ${matchedApp.name} not active, status: ${matchedApp.status}`);
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  if ((matchedApp["web-proxy"] ?? true) !== true) {
    console.warn(`[ws:upgrade] app ${matchedApp.name} has web-proxy disabled`);
    socket.write("HTTP/1.1 504 Gateway Timeout\r\n\r\n");
    socket.destroy();
    return;
  }

  const { host: targetHost, port: targetPort } = splitIpPort(networkEntry.ip);
  if (!targetHost || !targetPort || isNaN(targetPort)) {
    console.warn(`[ws:upgrade] invalid ip/port for app ${matchedApp.name}: ${networkEntry.ip}`);
    socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
    socket.destroy();
    return;
  }

  const reachable = await isPortReachable(targetHost, targetPort);
  if (!reachable) {
    console.warn(`[ws:upgrade] ${targetHost}:${targetPort} not reachable for ${matchedApp.name}`);
    socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    socket.destroy();
    return;
  }

  const label = `${matchedApp.name}`;
  console.log(`[ws:upgrade] forwarding ${host} -> ${targetHost}:${targetPort}`);
  return proxyWs(req, socket, head, targetHost, targetPort, label);
});

async function handleAppRequest(req, res, next, matchedApp, networkEntry) {
  const clientIp = getClientIp(req);
  const blockedList = Array.isArray(matchedApp.blocked) ? matchedApp.blocked : [];

  if (blockedList.includes(clientIp)) {
    return sendErrorPage(res, 403, "Access Denied",
      `Your IP address (${clientIp}) has been blocked by the application owner.`, "lock", matchedApp);
  }

  switch (matchedApp.status) {
    case "active":    break;
    case "suspended": return sendErrorPage(res, 403, "Application Suspended",
      "This application has been suspended due to inactivity.", "sleep", matchedApp);
    case "expired":   return sendErrorPage(res, 403, "VPS Expired",
      "This premium VPS has expired. Please renew to restore access.", "clock", matchedApp);
    case "stopped":   return sendErrorPage(res, 403, "Application Stopped",
      "This application has been stopped by the owner.", "stop", matchedApp);
    case "error":     return sendErrorPage(res, 500, "Application Error",
      "This application encountered an error. Check the deployment logs.", "bug", matchedApp);
    default:          return sendErrorPage(res, 403, "Application Unavailable",
      `This application is currently ${matchedApp.status}.`, "question", matchedApp);
  }

  // ── Web proxy toggle check ──────────────────────────────────────────────
  if ((matchedApp["web-proxy"] ?? true) !== true) {
    return sendErrorPage(res, 504, "Application Refused to Respond",
      "This application is currently not accepting incoming connections. The owner has disabled the web proxy for this app.", "offline", matchedApp);
  }

  const { host: targetHost, port: targetPort } = splitIpPort(networkEntry.ip);
  if (!targetHost || !targetPort || isNaN(targetPort)) {
    return sendErrorPage(res, 500, "Configuration Error",
      "The application has an invalid ip/port configuration. Please redeploy.", "wrench", matchedApp);
  }

  return createAppProxy(targetHost, targetPort, `${matchedApp.name}`, matchedApp)(req, res, next);
}

app.use((req, res, next) => {
  const host = req.headers.host || "";
  const cleanHost = host.split(":")[0].toLowerCase().trim();

  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} — ${cleanHost}`);

  if (cleanHost === PLATFORM_DOMAIN || cleanHost === `www.${PLATFORM_DOMAIN}`) {
    return mainProxy(req, res, next);
  }

  try {
    const match = resolveAppFromHost(cleanHost);

    if (match) return handleAppRequest(req, res, next, match.app, match.networkEntry);

    return sendErrorPage(res, 404, "Application Not Found",
      `No application is configured for "${cleanHost}".`, "notfound");

  } catch (err) {
    console.error("[router] Error:", err);
    return sendErrorPage(res, 500, "Internal Server Error",
      "Failed to load application data. Please try again later.", "error");
  }
});

server.listen(ROUTER_PORT, () => {
  console.log("=".repeat(60));
  console.log(`${PLATFORM_NAME} Router — port ${ROUTER_PORT}`);
  console.log(`Platform domain: ${PLATFORM_DOMAIN}`);
  console.log(`Main app target: ${MAIN_APP_HOST}:${MAIN_APP_PORT}`);
  console.log("=".repeat(60));
});
