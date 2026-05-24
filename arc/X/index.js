const express = require("express");
const fs = require("fs");
const { execFile, spawn } = require("child_process");
const path = require("path");
const bodyParser = require("body-parser");
const http = require("http");
const { WebSocketServer } = require("ws");

const app = express();
app.set("trust proxy", 1);
app.use(bodyParser.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const BASE_PATH    = "/platform/apps";
const DATA_PATH    = "/platform/data/ports.json";
const CRED_PATH    = "/platform/data/credentials.json";
const PAGES_PATH   = "/platform/pages";
const BACKUP_PATH  = "/platform/backups";
const NGINX_PATH   = "/etc/nginx/sites-enabled";
const VPS_IP       = "176.100.36.236";

const MS_1H   = 60 * 60 * 1000;
const MS_24H  = 24  * MS_1H;
const MS_72H  = 72  * MS_1H;
const MS_30D  = 30  * 24 * MS_1H;
const MS_35D  = 35  * 24 * MS_1H;

const FREE_RAM     = "512m";
const FREE_CPU     = "0.2";
const FREE_STORAGE = "4G";

const TIMEOUT = 20 * 60 * 1000;

const IMAGES = {
  nodejs:    "node:20-alpine",
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
  ruby:      "ruby:3.3-slim",
  php:       "php:8.3-cli-alpine",
  rust:      "rust:1.78-alpine",
  java:      "eclipse-temurin:21",
  dotnet:    "mcr.microsoft.com/dotnet/sdk:8.0",
  elixir:    "elixir:1.16-slim",
};


// ── Queue system for deploy / start / stop ───────────────────────────────────
const MAX_CONCURRENT = 5;
let activeJobs = 0;
const jobQueue = [];

function runQueued(fn) {
  return new Promise((resolve, reject) => {
    const job = async () => {
      activeJobs++;
      try { resolve(await fn()); }
      catch (e) { reject(e); }
      finally {
        activeJobs--;
        if (jobQueue.length > 0) jobQueue.shift()();
      }
    };
    if (activeJobs < MAX_CONCURRENT) job();
    else jobQueue.push(job);
  });
}

// ── Nginx domain rate limiter (10 min per IP) ────────────────────────────────
const nginxCooldown = new Map(); // ip -> timestamp
const NGINX_COOLDOWN_MS = 10 * 60 * 1000;

function checkNginxCooldown(ip) {
  const last = nginxCooldown.get(ip);
  if (!last) return null;
  const elapsed = Date.now() - last;
  if (elapsed < NGINX_COOLDOWN_MS) {
    const remaining = Math.ceil((NGINX_COOLDOWN_MS - elapsed) / 1000);
    return remaining;
  }
  return null;
}

function setNginxCooldown(ip) {
  nginxCooldown.set(ip, Date.now());
}

function safeRun(cmd, args = []) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TIMEOUT }, (err, stdout, stderr) => {
      if (err) return reject(stderr || err.toString());
      resolve((stdout || stderr).trim());
    });
  });
}

function loadData() {
  if (!fs.existsSync(DATA_PATH)) return {};
  return JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
}

function saveData(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
}

function loadCredentials() {
  if (!fs.existsSync(CRED_PATH)) return [];
  return JSON.parse(fs.readFileSync(CRED_PATH, "utf-8"));
}

function saveCredentials(data) {
  fs.writeFileSync(CRED_PATH, JSON.stringify(data, null, 2));
}

function validate(appName, password, data) {
  if (!data[appName]) return { ok: false, msg: "App not found" };
  if (data[appName].password !== password) return { ok: false, msg: "Invalid password" };
  return { ok: true };
}

function isValidName(name) {
  return typeof name === "string" && name.length > 0;
}

const RESERVED_APP_NAMES = ["cloudra", "vortexa"];

function validateAppName(name) {
  if (!isValidName(name)) {
    return { ok: false, msg: "App name must be a non-empty string" };
  }
  if (/[a-zA-Z]/.test(name) && /[A-Z]/.test(name)) {
    return { ok: false, msg: "App name must use only lowercase letters (no uppercase allowed)" };
  }
  if (RESERVED_APP_NAMES.includes(name.toLowerCase())) {
    return { ok: false, msg: `App name '${name}' is reserved and cannot be used` };
  }
  return { ok: true };
}

function isValidRepo(url) {
  return url.startsWith("https://github.com/");
}

function isValidUrl(url) {
  return /^https?:\/\/.+/.test(url);
}

function nowISO() {
  return new Date().toISOString();
}

async function purgeBackup(appName) {
  const backupDir = path.join(BACKUP_PATH, appName);
  if (fs.existsSync(backupDir)) {
    await safeRun("rm", ["-rf", backupDir]).catch(() => {});
    console.log(`[purge] Deleted backup directory for ${appName}`);
  }
}

async function purgeNginx(appName) {
  const nginxFile = path.join(NGINX_PATH, `${appName}.conf`);
  if (fs.existsSync(nginxFile)) {
    fs.unlinkSync(nginxFile);
    await safeRun("nginx", ["-s", "reload"]).catch(() => {});
    console.log(`[purge] Deleted nginx config for ${appName}`);
  }
}

async function purgeSSL(appName) {
  const certName = `${appName}.cloudra.vortexa.cloud`;
  await safeRun("certbot", ["delete", "--cert-name", certName, "--non-interactive"]).catch(() => {});
  console.log(`[purge] Deleted SSL cert for ${appName}`);
}

async function purgeApp(appName, { deleteBackup = false, domain = "", https = false } = {}) {
  // Remove SSL cert first if HTTPS was enabled
  if (https) await purgeSSL(appName);
  await safeRun("docker", ["rm", "-f", appName]).catch(() => {});
  await safeRun("docker", ["rmi", "-f", appName]).catch(() => {});
  await safeRun("rm", ["-rf", path.join(BASE_PATH, appName)]).catch(() => {});
  if (domain) await purgeNginx(appName);
  if (deleteBackup) await purgeBackup(appName);
}

function buildDockerfile(image, language, packages, startFile) {
  const extraPkgs = packages?.filter(Boolean) ?? [];
  const isNode = language.startsWith("nodejs");
  const isTs   = language === "ts" || language.startsWith("ts");

  let df = `FROM ${image}\nWORKDIR /app\nCOPY . .\n\n`;
  df += `RUN useradd -m appuser 2>/dev/null || adduser -D appuser\n\n`;

  // ── Node.js / TypeScript ──────────────────────────────────────────────────
  if (isNode || isTs) {
    // Always run npm install to pick up package.json deps (e.g. express)
    df += `RUN if [ -f package.json ]; then npm install; fi\n`;
    // Install any extra packages the user explicitly requested
    if (extraPkgs.length) df += `RUN npm install ${extraPkgs.join(" ")}\n`;
    // TypeScript toolchain
    if (isTs) df += `RUN npm install -g ts-node typescript\n`;
    df += `RUN mkdir -p /home/appuser/.npm && chown -R appuser:appuser /home/appuser/.npm\n`;

  // ── Python ────────────────────────────────────────────────────────────────
  } else if (language.startsWith("python")) {
    // Always install from requirements.txt if present
    df += `RUN if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; fi\n`;
    // Install any extra packages the user explicitly requested
    if (extraPkgs.length) df += `RUN pip install --no-cache-dir ${extraPkgs.join(" ")}\n`;
    df += `RUN mkdir -p /home/appuser/.cache/pip && chown -R appuser:appuser /home/appuser/.cache\n`;

  // ── Go ────────────────────────────────────────────────────────────────────
  } else if (language.startsWith("go")) {
    // Always run go mod download if go.mod is present
    df += `RUN if [ -f go.mod ]; then go mod download; fi\n`;
    if (extraPkgs.length) df += `RUN go get ${extraPkgs.join(" ")}\n`;
    df += `RUN mkdir -p /home/appuser/.cache/go-build /home/appuser/go && chown -R appuser:appuser /home/appuser/.cache /home/appuser/go\n`;
    df += `ENV GOPATH=/home/appuser/go\n`;
    df += `ENV GOCACHE=/home/appuser/.cache/go-build\n`;

  // ── Ruby ──────────────────────────────────────────────────────────────────
  } else if (language === "ruby") {
    // Always bundle install if Gemfile is present
    df += `RUN if [ -f Gemfile ]; then bundle install; fi\n`;
    if (extraPkgs.length) df += `RUN gem install ${extraPkgs.join(" ")}\n`;
    df += `RUN mkdir -p /home/appuser/.gem && chown -R appuser:appuser /home/appuser/.gem\n`;

  // ── PHP ───────────────────────────────────────────────────────────────────
  } else if (language === "php") {
    df += `RUN apt-get update -y && apt-get install -y --no-install-recommends composer && rm -rf /var/lib/apt/lists/*\n`;
    // Always composer install if composer.json is present
    df += `RUN if [ -f composer.json ]; then composer install --no-interaction --no-dev --optimize-autoloader; fi\n`;
    if (extraPkgs.length) df += `RUN composer require --no-interaction ${extraPkgs.join(" ")}\n`;
    df += `RUN mkdir -p /home/appuser/.composer && chown -R appuser:appuser /home/appuser/.composer\n`;

  // ── Bun ───────────────────────────────────────────────────────────────────
  } else if (language === "bun") {
    // Always bun install if package.json is present
    df += `RUN if [ -f package.json ]; then bun install; fi\n`;
    if (extraPkgs.length) df += `RUN bun add ${extraPkgs.join(" ")}\n`;
    df += `RUN mkdir -p /home/appuser/.bun && chown -R appuser:appuser /home/appuser/.bun\n`;

  // ── Rust ──────────────────────────────────────────────────────────────────
  } else if (language === "rust") {
    df += `RUN mkdir -p /home/appuser/.cargo && chown -R appuser:appuser /home/appuser/.cargo\n`;
    df += `ENV CARGO_HOME=/home/appuser/.cargo\n`;
    df += `RUN cargo build --release\n`;

  // ── Java ──────────────────────────────────────────────────────────────────
  } else if (language === "java") {
    df += `RUN apt-get update -y && apt-get install -y --no-install-recommends maven && rm -rf /var/lib/apt/lists/*\n`;
    // Always mvn install if pom.xml is present
    df += `RUN if [ -f pom.xml ]; then mvn install -DskipTests --no-transfer-progress; fi\n`;
    df += `RUN mkdir -p /home/appuser/.m2 && chown -R appuser:appuser /home/appuser/.m2\n`;

  // ── .NET ──────────────────────────────────────────────────────────────────
  } else if (language === "dotnet") {
    df += `ENV DOTNET_CLI_TELEMETRY_OPTOUT=1\n`;
    df += `ENV NUGET_PACKAGES=/home/appuser/.nuget/packages\n`;
    // Always restore if .csproj is present
    df += `RUN if [ -f *.csproj ] 2>/dev/null || ls *.csproj 2>/dev/null; then dotnet restore; fi\n`;
    df += `RUN mkdir -p /home/appuser/.dotnet /home/appuser/.nuget && chown -R appuser:appuser /home/appuser/.dotnet /home/appuser/.nuget\n`;

  // ── Elixir ────────────────────────────────────────────────────────────────
  } else if (language === "elixir") {
    df += `RUN mix local.hex --force && mix local.rebar --force\n`;
    // Always mix deps.get if mix.exs is present
    df += `RUN if [ -f mix.exs ]; then mix deps.get; fi\n`;
    if (extraPkgs.length) extraPkgs.forEach(p => { df += `RUN mix archive.install hex ${p} --force\n`; });
    df += `RUN mkdir -p /home/appuser/.mix /home/appuser/.hex && chown -R appuser:appuser /home/appuser/.mix /home/appuser/.hex\n`;

  // ── Deno ──────────────────────────────────────────────────────────────────
  } else if (language === "deno") {
    df += `ENV DENO_DIR=/home/appuser/.cache/deno\n`;
    // Cache deps from entry file ahead of time
    df += `RUN deno cache ${startFile} 2>/dev/null || true\n`;
    df += `RUN mkdir -p /home/appuser/.cache/deno && chown -R appuser:appuser /home/appuser/.cache\n`;
  }

  df += `\nRUN chown -R appuser:appuser /app\n`;
  df += `USER appuser\n\n`;

  // ── CMD ───────────────────────────────────────────────────────────────────
  if      (isNode)                              df += `CMD ["node", "${startFile}"]\n`;
  else if (isTs)                                df += `CMD ["npx", "ts-node", "${startFile}"]\n`;
  else if (language.startsWith("python"))       df += `CMD ["python3", "${startFile}"]\n`;
  else if (language.startsWith("go"))           df += `CMD ["go", "run", "${startFile}"]\n`;
  else if (language === "ruby")                 df += `CMD ["ruby", "${startFile}"]\n`;
  else if (language === "php")                  df += `CMD ["php", "${startFile}"]\n`;
  else if (language === "rust")                 df += `CMD ["./target/release/${startFile}"]\n`;
  else if (language === "java")                 df += `CMD ["java", "-jar", "${startFile}"]\n`;
  else if (language === "dotnet")               df += `CMD ["dotnet", "${startFile}"]\n`;
  else if (language === "elixir")               df += `CMD ["elixir", "${startFile}"]\n`;
  else if (language === "bun")                  df += `CMD ["bun", "run", "${startFile}"]\n`;
  else if (language === "deno")                 df += `CMD ["deno", "run", "--allow-all", "${startFile}"]\n`;

  return df;
}

async function runMonitor() {
  const data = loadData();
  const creds = loadCredentials();
  let dataDirty = false;
  let credsDirty = false;

  for (const [appName, entry] of Object.entries(data)) {
    const plan      = entry.plan || "free";
    const status    = entry.status;
    const createdAt = entry.createdAt;

    if (plan === "free") {
      const lastStart = entry.lastStart;
      if (!lastStart) continue;

      const elapsed = Date.now() - new Date(lastStart).getTime();

      if (elapsed >= MS_72H) {
        await purgeApp(appName, { domain: entry.domain || "", https: entry.https === true });
        delete data[appName];
        dataDirty = true;

        for (const user of creds) {
          const i = user.servers.indexOf(appName);
          if (i !== -1) { user.servers.splice(i, 1); credsDirty = true; }
        }

        console.log(`[monitor] REMOVED   ${appName} | plan=free | elapsed=${Math.round(elapsed / MS_1H)}h`);
        continue;
      }

      if (elapsed >= MS_24H && status !== "suspended") {
        await safeRun("docker", ["stop", appName]).catch(() => {});
        entry.status = "suspended";
        dataDirty = true;
        console.log(`[monitor] SUSPENDED ${appName} | plan=free | elapsed=${Math.round(elapsed / MS_1H)}h`);
      }

    } else if (plan === "premium") {
      if (!createdAt) continue;

      const elapsed = Date.now() - new Date(createdAt).getTime();

      if (elapsed >= MS_35D) {
        await purgeApp(appName, { deleteBackup: true, domain: entry.domain || "", https: entry.https === true });
        delete data[appName];
        dataDirty = true;

        for (const user of creds) {
          const i = user.servers.indexOf(appName);
          if (i !== -1) { user.servers.splice(i, 1); credsDirty = true; }
        }

        console.log(`[monitor] DELETED   ${appName} | plan=premium | elapsed=${Math.round(elapsed / MS_1H)}h`);
        continue;
      }

      if (elapsed >= MS_30D && status !== "expired") {
        await safeRun("docker", ["stop", appName]).catch(() => {});
        entry.status = "expired";
        dataDirty = true;
        console.log(`[monitor] EXPIRED   ${appName} | plan=premium | elapsed=${Math.round(elapsed / MS_1H)}h`);
      }
    }
  }

  if (dataDirty)  saveData(data);
  if (credsDirty) saveCredentials(creds);
}

setInterval(runMonitor, 5 * 60 * 1000);
runMonitor();

app.post("/api/deploy", async (req, res) => {
  const { username, password, appName, appPassword, repo, zipUrl, language, packages, startFile } = req.body;
  let logs = [];

  if (!username || !password || !appName || !appPassword || (!repo && !zipUrl) || !language || !startFile) {
    return res.json({ status: "error", message: "Missing required fields", logs });
  }

  const nameCheck = validateAppName(appName);
  if (!nameCheck.ok) {
    return res.json({ status: "error", message: nameCheck.msg });
  }

  if (!IMAGES[language]) {
    return res.json({ status: "error", message: `Unsupported runtime: ${language}. Supported: ${Object.keys(IMAGES).join(", ")}` });
  }

  if (repo && !isValidRepo(repo)) {
    return res.json({ status: "error", message: "Only GitHub repos allowed" });
  }

  if (zipUrl && !isValidUrl(zipUrl)) {
    return res.json({ status: "error", message: "Invalid zip URL" });
  }

  const creds = loadCredentials();
  const userIndex = creds.findIndex(c => c.username === username && c.pass === password);

  if (userIndex === -1) {
    return res.json({ status: "error", message: "Invalid username or password", logs });
  }

  const user = creds[userIndex];
  const data = loadData();

  if (user.servers.length === 0) {
    if (data[appName]) {
      return res.json({ status: "error", message: "App name already exists", logs });
    }

    const usedPorts = Object.values(data).map(v => parseInt(v.port.split(":")[1]));
    const totalApps = Object.keys(data).length;
    let newPort = 40000 + totalApps;
    while (usedPorts.includes(newPort)) newPort++;

    data[appName] = {
      password: appPassword,
      port: `${VPS_IP}:${newPort}`,
      logs: [],
      plan: "free",
      lastStart: nowISO(),
      status: "active",
      createdAt: null,
      ram: FREE_RAM,
      cpu: FREE_CPU,
      storage: FREE_STORAGE,
      https: false,
      domain: "",
      blocked: [],
      "web-proxy": false
    };
    saveData(data);

    creds[userIndex].servers.push(appName);
    saveCredentials(creds);

    return res.json({
      status: "claimed",
      message: "Free VPS claimed, now deploying",
      app: { name: appName, port: newPort, url: `http://${VPS_IP}:${newPort}` }
    });
  }

  if (!user.servers.includes(appName)) {
    return res.json({ status: "error", message: "You don't own this app", logs });
  }

  if (data[appName] && data[appName].password !== appPassword) {
    return res.json({ status: "error", message: "Invalid app password", logs });
  }

  const existingEntry  = data[appName] || {};
  const plan           = existingEntry.plan || "free";
  const existingStatus = existingEntry.status;

  if (plan === "premium" && existingStatus === "expired") {
    return res.json({ status: "error", message: "This VPS has expired and cannot be redeployed", logs });
  }

  const existingCreatedAt = existingEntry.createdAt || null;
  const ram     = existingEntry.ram     || FREE_RAM;
  const cpu     = existingEntry.cpu     || FREE_CPU;
  const storage = existingEntry.storage || FREE_STORAGE;
  const appPath = path.join(BASE_PATH, appName);

  try {
    await safeRun("docker", ["rm", "-f", appName]).catch(() => {});
    await safeRun("rm", ["-rf", appPath]);
    await safeRun("mkdir", ["-p", appPath]);

    if (repo) {
      logs.push(await safeRun("git", ["clone", repo, appPath]));
    } else {
      const zipPath = path.join(appPath, "code.zip");
      logs.push(await safeRun("curl", ["-L", zipUrl, "-o", zipPath]));
      logs.push(await safeRun("unzip", [zipPath, "-d", appPath]));
      await safeRun("rm", [zipPath]);
    }

    const dockerfile = buildDockerfile(IMAGES[language], language, packages, startFile);
    fs.writeFileSync(path.join(appPath, "Dockerfile"), dockerfile);
    logs.push("Dockerfile created.");

    await runQueued(async () => {
      logs.push(await safeRun("docker", ["build", "-t", appName, appPath]));
      logs.push("Docker image built.");
    });

    const port = parseInt(data[appName].port.split(":")[1]);

    logs.push(await runQueued(() => safeRun("docker", [
      "run", "-d",
      "--name", appName,
      "-p", `${port}:${port}`,
      `--memory=${ram}`,
      `--cpus=${cpu}`,
      "--pids-limit=200",
      "--security-opt=no-new-privileges",
      "--cap-drop=ALL",
      "--cap-add=NET_BIND_SERVICE",
      "--ulimit", "nproc=200",
      "--ulimit", "nofile=1024",
      "--tmpfs", "/tmp:rw,size=100m,noexec",
      "--restart=on-failure:2",
      "--network=bridge",
      appName
    ])));

    logs.push(`Container started on port ${port}`);

    const resolvedCreatedAt = plan === "premium"
      ? (existingCreatedAt || nowISO())
      : null;

    data[appName] = {
      password: appPassword,
      port: `${VPS_IP}:${port}`,
      logs,
      plan,
      lastStart: nowISO(),
      status: "active",
      createdAt: resolvedCreatedAt,
      ram,
      cpu,
      storage,
      https: existingEntry.https ?? false,
      domain: existingEntry.domain ?? "",
      blocked: existingEntry.blocked ?? []
    };
    saveData(data);

    res.json({
      status: "success",
      app: { name: appName, port, url: `http://${VPS_IP}:${port}` },
      logs
    });

  } catch (err) {
    logs.push(err.toString());
    const ex = data[appName] || {};
    data[appName] = {
      password: appPassword,
      port: ex.port || null,
      logs,
      plan: ex.plan || "free",
      lastStart: ex.lastStart || nowISO(),
      status: "error",
      createdAt: ex.createdAt || null,
      ram: ex.ram || FREE_RAM,
      cpu: ex.cpu || FREE_CPU,
      storage: ex.storage || FREE_STORAGE,
      https: ex.https ?? false,
      domain: ex.domain ?? "",
      blocked: ex.blocked ?? []
    };
    saveData(data);

    res.json({ status: "error", message: "Deployment failed", logs });
  }
});

app.post("/api/stop", async (req, res) => {
  const { appName, password } = req.body;
  const data = loadData();

  const v = validate(appName, password, data);
  if (!v.ok) return res.json({ status: "error", message: v.msg });

  const plan   = data[appName].plan || "free";
  const status = data[appName].status;

  if (plan === "premium" && status === "expired") {
    return res.json({ status: "error", message: "This VPS has expired and cannot be controlled" });
  }

  try {
    const out = await runQueued(() => safeRun("docker", ["stop", appName]));
    data[appName].status = "stopped";
    saveData(data);
    res.json({ status: "success", output: out });
  } catch (e) {
    res.json({ status: "error", message: e.toString() });
  }
});

app.post("/api/start", async (req, res) => {
  const { appName, password } = req.body;
  const data = loadData();

  const v = validate(appName, password, data);
  if (!v.ok) return res.json({ status: "error", message: v.msg });

  const plan   = data[appName].plan || "free";
  const status = data[appName].status;

  if (plan === "premium" && status === "expired") {
    return res.json({ status: "error", message: "This VPS has expired and cannot be controlled" });
  }

  try {
    const out = await runQueued(() => safeRun("docker", ["start", appName]));
    data[appName].lastStart = nowISO();
    data[appName].status = "active";
    saveData(data);
    res.json({ status: "success", output: out });
  } catch (e) {
    res.json({ status: "error", message: e.toString() });
  }
});

app.post("/api/inspect", async (req, res) => {
  const { appName, password } = req.body;
  const data = loadData();

  const v = validate(appName, password, data);
  if (!v.ok) return res.json({ status: "error", message: v.msg });

  try {
    const out  = await safeRun("docker", ["inspect", appName]);
    const json = JSON.parse(out);

    json.forEach(c => {
      delete c.HostConfig;
      delete c.GraphDriver;
      delete c.Mounts;
    });

    res.json({ status: "success", data: json });
  } catch (e) {
    res.json({ status: "error", message: e.toString() });
  }
});

app.post("/api/logs", async (req, res) => {
  const { appName, password } = req.body;
  const data = loadData();

  const v = validate(appName, password, data);
  if (!v.ok) return res.json({ status: "error", message: v.msg });

  try {
    const out = await safeRun("docker", ["logs", appName]);
    res.json({ status: "success", logs: out });
  } catch (e) {
    res.json({ status: "error", message: e.toString() });
  }
});

// ── Discord OAuth helper ─────────────────────────────────────────────────────
async function discordExchange(code, redirectUri) {
  const params = new URLSearchParams({
    client_id:     "1506619418678136862",
    client_secret: "5TW4cC3fnM-fqCse50R8Nt6iJxAeeDyZ",
    grant_type:    "authorization_code",
    code,
    redirect_uri:  redirectUri
  });
  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
  if (!tokenRes.ok) throw new Error("Token exchange failed");
  const tokenData = await tokenRes.json();

  const userRes = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` }
  });
  if (!userRes.ok) throw new Error("Failed to fetch Discord user");
  return userRes.json();
}

function genPassword(len = 32) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// ── /api/signup (Discord OAuth) ──────────────────────────────────────────────
app.post("/api/signup", async (req, res) => {
  const { code } = req.body;
  const ip = req.headers['x-forwarded-for']
    ? req.headers['x-forwarded-for'].split(',')[0].trim()
    : req.socket.remoteAddress || req.ip;

  if (!code) return res.json({ status: "error", message: "Missing Discord code" });

  let discordUser;
  try {
    discordUser = await discordExchange(code, "https://cloudra.vortexa.cloud/sign-up");
  } catch (e) {
    return res.json({ status: "error", message: "Discord auth failed: " + e.message });
  }

  if (!discordUser.verified) {
    return res.json({ status: "error", message: "Your Discord email is not verified" });
  }

  const username = discordUser.username;
  const email    = discordUser.email;
  const userId   = discordUser.id;
  const avatar   = discordUser.avatar;

  const creds = loadCredentials();

  if (creds.some(c => c.username === username)) {
    return res.json({ status: "error", message: "An account with this Discord username already exists" });
  }
  if (creds.some(c => c.email === email)) {
    return res.json({ status: "error", message: "An account with this Discord email already exists" });
  }
  if (creds.some(c => c.ip === ip)) {
    return res.json({ status: "error", message: "Only one account per IP allowed" });
  }

  const pass = genPassword();
  creds.push({ username, pass, email, discordId: userId, avatar, servers: [], ip });
  saveCredentials(creds);

  res.json({ status: "success", username, pass, discordId: userId, avatar });
});

// ── /api/login (Discord OAuth) ───────────────────────────────────────────────
app.post("/api/login", async (req, res) => {
  const { code } = req.body;

  if (!code) return res.json({ status: "error", message: "Missing Discord code" });

  let discordUser;
  try {
    discordUser = await discordExchange(code, "https://cloudra.vortexa.cloud/login");
  } catch (e) {
    return res.json({ status: "error", message: "Discord auth failed: " + e.message });
  }

  const username = discordUser.username;
  const email    = discordUser.email;
  const userId   = discordUser.id;
  const avatar   = discordUser.avatar;

  const creds = loadCredentials();
  const user  = creds.find(c => c.username === username && c.email === email);

  if (!user) {
    return res.json({ status: "error", valid: false, message: "No account found for this Discord account" });
  }

  res.json({ status: "success", valid: true, username, pass: user.pass, discordId: userId, avatar });
});

app.post("/api/get-app", (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.json({ status: "error", message: "Missing username or password" });
  }

  const creds = loadCredentials();
  const user  = creds.find(c => c.username === username && c.pass === password);

  if (!user) {
    return res.json({ status: "error", message: "Invalid username or password" });
  }

  if (user.servers.length === 0) {
    return res.json({ status: "success", apps: {} });
  }

  const data = loadData();
  const apps = {};

  user.servers.forEach(appName => {
    if (data[appName]) {
      const { password: appPass, port: ipPort, logs, plan, lastStart, status, createdAt, ram, cpu, storage } = data[appName];
      apps[appName] = { appPass, ipPort, logs, plan, lastStart, status, createdAt, ram, cpu, storage };
    }
  });

  res.json({ status: "success", apps });
});

app.post("/api/delete-app", async (req, res) => {
  const { username, password, appName, appPassword } = req.body;

  if (!username || !password || !appName || !appPassword) {
    return res.json({ status: "error", message: "Missing required fields" });
  }

  const creds = loadCredentials();
  const userIndex = creds.findIndex(c => c.username === username && c.pass === password);

  if (userIndex === -1) {
    return res.json({ status: "error", message: "Invalid username or password" });
  }

  if (!creds[userIndex].servers.includes(appName)) {
    return res.json({ status: "error", message: "You don't own this app" });
  }

  const data = loadData();

  if (!data[appName]) {
    return res.json({ status: "error", message: "App not found" });
  }

  if (data[appName].password !== appPassword) {
    return res.json({ status: "error", message: "Invalid app password" });
  }

  try {
    const isPremium = (data[appName].plan || "free") === "premium";
    await purgeApp(appName, { deleteBackup: isPremium, domain: data[appName].domain || "", https: data[appName].https === true });

    delete data[appName];
    saveData(data);

    creds[userIndex].servers = creds[userIndex].servers.filter(s => s !== appName);
    saveCredentials(creds);

    res.json({ status: "success", message: `App ${appName} deleted successfully` });
  } catch (e) {
    res.json({ status: "error", message: e.toString() });
  }
});

app.post("/api/delete-account", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.json({ status: "error", message: "Missing username or password" });
  }

  const creds = loadCredentials();
  const userIndex = creds.findIndex(c => c.username === username && c.pass === password);

  if (userIndex === -1) {
    return res.json({ status: "error", message: "Invalid username or password" });
  }

  const user = creds[userIndex];
  const data = loadData();

  for (const appName of user.servers) {
    const entry = data[appName] || {};
    await purgeApp(appName, { deleteBackup: (entry.plan || "free") === "premium", domain: entry.domain || "", https: entry.https === true });
    delete data[appName];
  }

  saveData(data);
  creds.splice(userIndex, 1);
  saveCredentials(creds);

  res.json({ status: "success", message: "Account and all associated apps have been permanently deleted" });
});

app.post("/api/change-app-password", (req, res) => {
  const { username, password, appName, oldAppPassword, newAppPassword } = req.body;

  if (!username || !password || !appName || !oldAppPassword || !newAppPassword) {
    return res.json({ status: "error", message: "Missing required fields" });
  }

  if (newAppPassword.length < 4) {
    return res.json({ status: "error", message: "New app password must be at least 4 characters" });
  }

  const creds = loadCredentials();
  const user  = creds.find(c => c.username === username && c.pass === password);

  if (!user) {
    return res.json({ status: "error", message: "Invalid username or password" });
  }

  if (!user.servers.includes(appName)) {
    return res.json({ status: "error", message: "You don't own this app" });
  }

  const data = loadData();

  if (!data[appName]) {
    return res.json({ status: "error", message: "App not found" });
  }

  if (data[appName].password !== oldAppPassword) {
    return res.json({ status: "error", message: "Invalid current app password" });
  }

  data[appName].password = newAppPassword;
  saveData(data);

  res.json({ status: "success", message: "App password updated successfully" });
});
app.post("/api/admin", async (req, res) => {
  const { key1, key2, key3, action, ...params } = req.body;

  const ADMIN_KEYS = ["thisISVERYVERYSECRET", "totallySECRET", 'A++()/'];

  if (key1 !== ADMIN_KEYS[0] || key2 !== ADMIN_KEYS[1] || key3 !== ADMIN_KEYS[2]) {
    return res.json({ status: "error", message: "Invalid admin keys" });
  }

  if (action === "get-all-data") {
    const creds = loadCredentials();
    const ports = loadData();
    return res.json({ status: "success", credentials: creds, ports: ports });
  }

  if (action === "give-vps") {
    const { username, appName, appPassword, plan, ram, cpu, storage } = params;

    if (!username || !appName || !appPassword || !plan) {
      return res.json({ status: "error", message: "Missing required fields: username, appName, appPassword, plan" });
    }

    const nameCheck = validateAppName(appName);
    if (!nameCheck.ok) {
      return res.json({ status: "error", message: nameCheck.msg });
    }

    if (!["free", "premium"].includes(plan)) {
      return res.json({ status: "error", message: "Plan must be 'free' or 'premium'" });
    }

    const creds = loadCredentials();
    const userIndex = creds.findIndex(c => c.username === username);

    if (userIndex === -1) {
      return res.json({ status: "error", message: "User not found" });
    }

    const data = loadData();

    if (data[appName]) {
      return res.json({ status: "error", message: "App name already exists" });
    }

    const usedPorts = Object.values(data).map(v => parseInt(v.port.split(":")[1]));
    let newPort = 40000 + Object.keys(data).length;
    while (usedPorts.includes(newPort)) newPort++;

    const finalRam = ram || "512m";
    const finalCpu = cpu || "0.2";
    const finalStorage = storage || "4G";
    const createdAt = plan === "premium" ? nowISO() : null;
    const lastStart = plan === "free" ? nowISO() : null;

    data[appName] = {
      password: appPassword,
      port: `${VPS_IP}:${newPort}`,
      logs: [],
      plan: plan,
      lastStart: lastStart,
      status: "active",
      createdAt: createdAt,
      ram: finalRam,
      cpu: finalCpu,
      storage: finalStorage,
      https: false,
      domain: "",
      blocked: [],
      "web-proxy": false
    };
    saveData(data);

    creds[userIndex].servers.push(appName);
    saveCredentials(creds);

    res.json({
      status: "success",
      message: `VPS assigned to ${username}`,
      app: { name: appName, port: newPort, url: `http://${VPS_IP}:${newPort}`, plan: plan, ram: finalRam, cpu: finalCpu, storage: finalStorage }
    });
  }

  if (action === "delete-vps") {
    const { appName } = params;

    if (!appName) {
      return res.json({ status: "error", message: "Missing appName" });
    }

    const data = loadData();
    const creds = loadCredentials();

    if (!data[appName]) {
      return res.json({ status: "error", message: "App not found" });
    }

    const entryToDelete = data[appName] || {};
    await purgeApp(appName, { deleteBackup: (entryToDelete.plan || "free") === "premium", domain: entryToDelete.domain || "", https: entryToDelete.https === true });
    delete data[appName];
    saveData(data);

    for (const user of creds) {
      const idx = user.servers.indexOf(appName);
      if (idx !== -1) {
        user.servers.splice(idx, 1);
        break;
      }
    }
    saveCredentials(creds);

    res.json({ status: "success", message: `VPS ${appName} deleted` });
  }

  if (action === "get-user") {
    const { username } = params;

    if (!username) {
      return res.json({ status: "error", message: "Missing username" });
    }

    const creds = loadCredentials();
    const user = creds.find(c => c.username === username);

    if (!user) {
      return res.json({ status: "error", message: "User not found" });
    }

    const data = loadData();
    const userApps = {};
    user.servers.forEach(appName => {
      if (data[appName]) {
        userApps[appName] = data[appName];
      }
    });

    res.json({ status: "success", user: { username: user.username, ip: user.ip, servers: userApps } });
  }

  if (action === "list-users") {
    const creds = loadCredentials();
    const users = creds.map(c => ({ username: c.username, ip: c.ip, serverCount: c.servers.length }));
    res.json({ status: "success", users: users });
  }

  if (action === "update-plan") {
    const { appName, newPlan, ram, cpu, storage } = params;

    if (!appName || !newPlan || !["free", "premium"].includes(newPlan)) {
      return res.json({ status: "error", message: "Missing appName or invalid plan" });
    }

    const data = loadData();

    if (!data[appName]) {
      return res.json({ status: "error", message: "App not found" });
    }

    data[appName].plan = newPlan;
    
    if (ram) data[appName].ram = ram;
    if (cpu) data[appName].cpu = cpu;
    if (storage) data[appName].storage = storage;
    
    if (newPlan === "premium" && !data[appName].createdAt) {
      data[appName].createdAt = nowISO();
      data[appName].lastStart = null;
    }
    if (newPlan === "free") {
      data[appName].createdAt = null;
      if (!data[appName].lastStart) data[appName].lastStart = nowISO();
    }
    
    saveData(data);

    res.json({ status: "success", message: `Plan for ${appName} updated to ${newPlan}`, app: data[appName] });
  }

  res.json({ status: "error", message: `Unknown action: ${action}. Available: get-all-data, give-vps, delete-vps, get-user, list-users, update-plan` });
});
// ─────────────────────────────────────────────────────────────────────────────
// BACKUP ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// ── /api/backup-create ───────────────────────────────────────────────────────
app.post("/api/backup-create", async (req, res) => {
  const { username, password, appName, appPassword } = req.body;

  if (!username || !password || !appName || !appPassword) {
    return res.json({ status: "error", message: "Missing required fields" });
  }

  // Validate account credentials
  const creds = loadCredentials();
  const user  = creds.find(c => c.username === username && c.pass === password);
  if (!user) return res.json({ status: "error", message: "Invalid username or password" });

  if (!user.servers.includes(appName)) {
    return res.json({ status: "error", message: "You don't own this app" });
  }

  // Validate app password
  const data = loadData();
  if (!data[appName]) return res.json({ status: "error", message: "App not found" });
  if (data[appName].password !== appPassword) return res.json({ status: "error", message: "Invalid app password" });

  // Premium-only
  if ((data[appName].plan || "free") !== "premium") {
    return res.json({ status: "error", message: "Backups are available on premium plan only" });
  }

  // Load or init backup index
  const appBackupDir  = path.join(BACKUP_PATH, appName);
  const backupIndexPath = path.join(appBackupDir, "index.json");
  fs.mkdirSync(appBackupDir, { recursive: true });

  let index = [];
  if (fs.existsSync(backupIndexPath)) {
    try { index = JSON.parse(fs.readFileSync(backupIndexPath, "utf-8")); } catch { index = []; }
  }

  // Enforce 5-backup limit — remove oldest if at cap
  if (index.length >= 5) {
    const oldest = index.shift();
    const oldTar = path.join(appBackupDir, `${oldest.id}.tar.gz`);
    const oldZip = path.join(appBackupDir, `${oldest.id}.zip`);
    if (fs.existsSync(oldTar)) fs.unlinkSync(oldTar);
    if (fs.existsSync(oldZip)) fs.unlinkSync(oldZip);
  }

  // Generate backup ID: timestamp-based
  const backupId  = `bkp_${Date.now()}`;
  const tarPath   = path.join(appBackupDir, `${backupId}.tar.gz`);
  const appPath   = path.join(BASE_PATH, appName);

  try {
    // Use tar (always available on Linux) — no extra packages needed
    await new Promise((resolve, reject) => {
      execFile("tar", ["--exclude=.git", "-czf", tarPath, "-C", appPath, "."], { timeout: TIMEOUT }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve();
      });
    });

    const createdAt = nowISO();
    index.push({ id: backupId, createdAt, tarPath });
    fs.writeFileSync(backupIndexPath, JSON.stringify(index, null, 2));

    res.json({ status: "success", message: "Backup created", backup: { id: backupId, createdAt } });
  } catch (e) {
    res.json({ status: "error", message: "Backup failed: " + e.toString() });
  }
});

// ── /api/backup-delete ───────────────────────────────────────────────────────
app.post("/api/backup-delete", async (req, res) => {
  const { username, password, appName, appPassword, backupId } = req.body;

  if (!username || !password || !appName || !appPassword || !backupId) {
    return res.json({ status: "error", message: "Missing required fields" });
  }

  // Validate account
  const creds = loadCredentials();
  const user  = creds.find(c => c.username === username && c.pass === password);
  if (!user) return res.json({ status: "error", message: "Invalid username or password" });

  if (!user.servers.includes(appName)) {
    return res.json({ status: "error", message: "You don't own this app" });
  }

  // Validate app password
  const data = loadData();
  if (!data[appName]) return res.json({ status: "error", message: "App not found" });
  if (data[appName].password !== appPassword) return res.json({ status: "error", message: "Invalid app password" });

  const appBackupDir    = path.join(BACKUP_PATH, appName);
  const backupIndexPath = path.join(appBackupDir, "index.json");

  if (!fs.existsSync(backupIndexPath)) {
    return res.json({ status: "error", message: "No backups found for this app" });
  }

  let index = [];
  try { index = JSON.parse(fs.readFileSync(backupIndexPath, "utf-8")); } catch { index = []; }

  const entryIdx = index.findIndex(b => b.id === backupId);
  if (entryIdx === -1) return res.json({ status: "error", message: "Backup not found" });

  const zipPath = path.join(appBackupDir, `${backupId}.zip`);
  const tarPath = path.join(appBackupDir, `${backupId}.tar.gz`);
  if (fs.existsSync(tarPath)) fs.unlinkSync(tarPath);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); // clean up old zip backups too

  index.splice(entryIdx, 1);
  fs.writeFileSync(backupIndexPath, JSON.stringify(index, null, 2));

  res.json({ status: "success", message: `Backup ${backupId} deleted` });
});

// ── /api/backup-get ──────────────────────────────────────────────────────────
app.post("/api/backup-get", (req, res) => {
  const { username, password, appName, appPassword } = req.body;

  if (!username || !password || !appName || !appPassword) {
    return res.json({ status: "error", message: "Missing required fields" });
  }

  // Validate account
  const creds = loadCredentials();
  const user  = creds.find(c => c.username === username && c.pass === password);
  if (!user) return res.json({ status: "error", message: "Invalid username or password" });

  if (!user.servers.includes(appName)) {
    return res.json({ status: "error", message: "You don't own this app" });
  }

  // Validate app password
  const data = loadData();
  if (!data[appName]) return res.json({ status: "error", message: "App not found" });
  if (data[appName].password !== appPassword) return res.json({ status: "error", message: "Invalid app password" });

  const appBackupDir    = path.join(BACKUP_PATH, appName);
  const backupIndexPath = path.join(appBackupDir, "index.json");

  if (!fs.existsSync(backupIndexPath)) {
    return res.json({ status: "success", backups: [] });
  }

  let index = [];
  try { index = JSON.parse(fs.readFileSync(backupIndexPath, "utf-8")); } catch { index = []; }

  // Return each backup entry with its archive as base64 content
  const backups = index.map(entry => {
    const tarPath = path.join(appBackupDir, `${entry.id}.tar.gz`);
    const zipPath = path.join(appBackupDir, `${entry.id}.zip`); // legacy
    const archivePath = fs.existsSync(tarPath) ? tarPath : (fs.existsSync(zipPath) ? zipPath : null);
    let zipContent = null;
    if (archivePath) {
      zipContent = fs.readFileSync(archivePath).toString("base64");
    }
    return {
      id: entry.id,
      createdAt: entry.createdAt,
      zipContent   // base64-encoded archive, or null if file missing
    };
  });

  res.json({ status: "success", backups });
});

// ── /api/backup-restore ──────────────────────────────────────────────────────
app.post("/api/backup-restore", async (req, res) => {
  const { username, password, appName, appPassword, backupId, language, packages, startFile } = req.body;
  let logs = [];

  if (!username || !password || !appName || !appPassword || !backupId || !language || !startFile) {
    return res.json({ status: "error", message: "Missing required fields", logs });
  }

  if (!IMAGES[language]) {
    return res.json({ status: "error", message: `Unsupported runtime: ${language}. Supported: ${Object.keys(IMAGES).join(", ")}`, logs });
  }

  // Validate account
  const creds     = loadCredentials();
  const userIndex = creds.findIndex(c => c.username === username && c.pass === password);
  if (userIndex === -1) return res.json({ status: "error", message: "Invalid username or password", logs });

  const user = creds[userIndex];
  if (!user.servers.includes(appName)) {
    return res.json({ status: "error", message: "You don't own this app", logs });
  }

  // Validate app password & plan
  const data = loadData();
  if (!data[appName]) return res.json({ status: "error", message: "App not found", logs });
  if (data[appName].password !== appPassword) return res.json({ status: "error", message: "Invalid app password", logs });

  if ((data[appName].plan || "free") !== "premium") {
    return res.json({ status: "error", message: "Backup restore is available on premium plan only", logs });
  }

  if (data[appName].status === "expired") {
    return res.json({ status: "error", message: "This VPS has expired and cannot be restored", logs });
  }

  // Locate the backup zip
  const appBackupDir    = path.join(BACKUP_PATH, appName);
  const backupIndexPath = path.join(appBackupDir, "index.json");

  if (!fs.existsSync(backupIndexPath)) {
    return res.json({ status: "error", message: "No backups found for this app", logs });
  }

  let index = [];
  try { index = JSON.parse(fs.readFileSync(backupIndexPath, "utf-8")); } catch { index = []; }

  const backupEntry = index.find(b => b.id === backupId);
  if (!backupEntry) return res.json({ status: "error", message: "Backup not found", logs });

  const zipPath = path.join(appBackupDir, `${backupId}.zip`);   // legacy
  const tarPath = path.join(appBackupDir, `${backupId}.tar.gz`);
  const archivePath = fs.existsSync(tarPath) ? tarPath : (fs.existsSync(zipPath) ? zipPath : null);
  if (!archivePath) {
    return res.json({ status: "error", message: "Backup file missing on disk", logs });
  }

  // ── Restore flow (mirrors /api/deploy from this point on) ─────────────────
  const existingEntry = data[appName];
  const plan          = existingEntry.plan || "free";
  const existingCreatedAt = existingEntry.createdAt || null;
  const ram     = existingEntry.ram     || FREE_RAM;
  const cpu     = existingEntry.cpu     || FREE_CPU;
  const storage = existingEntry.storage || FREE_STORAGE;
  const appPath = path.join(BASE_PATH, appName);

  try {
    await safeRun("docker", ["rm", "-f", appName]).catch(() => {});
    await safeRun("rm", ["-rf", appPath]);
    await safeRun("mkdir", ["-p", appPath]);

    // Extract backup archive into app directory
    if (archivePath.endsWith(".tar.gz")) {
      logs.push(await safeRun("tar", ["-xzf", archivePath, "-C", appPath]));
    } else {
      logs.push(await safeRun("unzip", ["-o", archivePath, "-d", appPath]));
    }
    logs.push("Backup extracted.");

    const dockerfile = buildDockerfile(IMAGES[language], language, packages, startFile);
    fs.writeFileSync(path.join(appPath, "Dockerfile"), dockerfile);
    logs.push("Dockerfile created.");

    logs.push(await safeRun("docker", ["build", "-t", appName, appPath]));
    logs.push("Docker image built.");

    const port = parseInt(data[appName].port.split(":")[1]);

    logs.push(await safeRun("docker", [
      "run", "-d",
      "--name", appName,
      "-p", `${port}:${port}`,
      `--memory=${ram}`,
      `--cpus=${cpu}`,
      "--pids-limit=200",
      "--security-opt=no-new-privileges",
      "--cap-drop=ALL",
      "--cap-add=NET_BIND_SERVICE",
      "--ulimit", "nproc=200",
      "--ulimit", "nofile=1024",
      "--tmpfs", "/tmp:rw,size=100m,noexec",
      "--restart=on-failure:2",
      "--network=bridge",
      appName
    ]));

    logs.push(`Container started on port ${port}`);

    const resolvedCreatedAt = plan === "premium"
      ? (existingCreatedAt || nowISO())
      : null;

    data[appName] = {
      password: appPassword,
      port: `${VPS_IP}:${port}`,
      logs,
      plan,
      lastStart: nowISO(),
      status: "active",
      createdAt: resolvedCreatedAt,
      ram,
      cpu,
      storage,
      https: existingEntry.https ?? false,
      domain: existingEntry.domain ?? "",
      blocked: existingEntry.blocked ?? []
    };
    saveData(data);

    res.json({
      status: "success",
      message: `App ${appName} restored from backup ${backupId}`,
      app: { name: appName, port, url: `http://${VPS_IP}:${port}` },
      logs
    });

  } catch (err) {
    logs.push(err.toString());
    const ex = data[appName] || {};
    data[appName] = {
      password: appPassword,
      port: ex.port || null,
      logs,
      plan: ex.plan || "free",
      lastStart: ex.lastStart || nowISO(),
      status: "error",
      createdAt: ex.createdAt || null,
      ram: ex.ram || FREE_RAM,
      cpu: ex.cpu || FREE_CPU,
      storage: ex.storage || FREE_STORAGE,
      https: ex.https ?? false,
      domain: ex.domain ?? "",
      blocked: ex.blocked ?? []
    };
    saveData(data);

    res.json({ status: "error", message: "Restore failed", logs });
  }
});

// ── /api/load ────────────────────────────────────────────────────────────────
// Returns RAM, disk, and CPU usage for a container after validating credentials
app.post("/api/load", async (req, res) => {
  const { username, password, appName, appPassword } = req.body;

  if (!username || !password || !appName || !appPassword) {
    return res.json({ status: "error", message: "Missing required fields" });
  }

  // Validate account
  const creds = loadCredentials();
  const user  = creds.find(c => c.username === username && c.pass === password);
  if (!user) return res.json({ status: "error", message: "Invalid username or password" });

  if (!user.servers.includes(appName)) {
    return res.json({ status: "error", message: "You don't own this app" });
  }

  // Validate app password
  const data = loadData();
  if (!data[appName]) return res.json({ status: "error", message: "App not found" });
  if (data[appName].password !== appPassword) return res.json({ status: "error", message: "Invalid app password" });

  try {
    // docker stats returns: ID, Name, CPU%, MemUsage/Limit, MemPerc, NetIO, BlockIO, PIDs
    const statsRaw = await safeRun("docker", [
      "stats", appName, "--no-stream", "--format",
      "{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.BlockIO}}"
    ]);

    const [cpuPerc, memUsage, memPerc, blockIO] = statsRaw.split("\t");

    // Parse memory usage e.g. "45.3MiB / 512MiB"
    const [memUsed, memLimit] = memUsage.split(" / ");

    // Parse disk (block IO) e.g. "10.2MB / 50MB"
    const [diskRead, diskWrite] = blockIO.split(" / ");

    res.json({
      status: "success",
      appName,
      usage: {
        cpu: cpuPerc.trim(),
        ram: {
          used: memUsed.trim(),
          limit: memLimit.trim(),
          percent: memPerc.trim()
        },
        disk: {
          read: diskRead.trim(),
          write: diskWrite.trim()
        }
      }
    });
  } catch (e) {
    res.json({ status: "error", message: "Failed to fetch container stats: " + e.toString() });
  }
});

// ── /api/domain ──────────────────────────────────────────────────────────────
// Validates a custom domain via Cloudflare DNS-over-HTTPS and assigns it to an app
app.post("/api/domain", async (req, res) => {
  const { username, password, appName, appPassword, domain } = req.body;

  if (!username || !password || !appName || !appPassword || !domain) {
    return res.json({ status: "error", message: "Missing required fields" });
  }

  // Validate domain format (basic check)
  if (!/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(domain)) {
    return res.json({ status: "error", message: "Invalid domain format" });
  }

  // Disallow domains containing "cloudra"
  if (domain.toLowerCase().includes("cloudra")) {
    return res.json({ status: "error", message: "Domain cannot contain 'cloudra'" });
  }

  // Check nginx cooldown (10 min per IP)
  const clientIp = req.ip || req.connection.remoteAddress;
  const cooldownRemaining = checkNginxCooldown(clientIp);
  if (cooldownRemaining !== null) {
    return res.json({ status: "error", message: `Please wait ${cooldownRemaining} seconds before updating your domain again` });
  }

  // Validate account
  const creds = loadCredentials();
  const user  = creds.find(c => c.username === username && c.pass === password);
  if (!user) return res.json({ status: "error", message: "Invalid username or password" });

  if (!user.servers.includes(appName)) {
    return res.json({ status: "error", message: "You don't own this app" });
  }

  // Validate app password
  const data = loadData();
  if (!data[appName]) return res.json({ status: "error", message: "App not found" });
  if (data[appName].password !== appPassword) return res.json({ status: "error", message: "Invalid app password" });

  // Premium only
  if ((data[appName].plan || "free") !== "premium") {
    return res.json({ status: "error", message: "Custom domains are only available for premium VPS" });
  }

  // Check if domain is already assigned to another app
  const alreadyUsed = Object.entries(data).find(
    ([name, entry]) => entry.domain === domain && name !== appName
  );
  if (alreadyUsed) {
    return res.json({ status: "error", message: "Domain is already assigned to another app" });
  }

  // Lookup domain A record via Cloudflare DNS-over-HTTPS
  try {
    const dnsUrl = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=A`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    let dnsRes;
    try {
      dnsRes = await fetch(dnsUrl, {
        signal: controller.signal,
        headers: { Accept: "application/dns-json" }
      });
    } finally {
      clearTimeout(timer);
    }

    if (!dnsRes.ok) {
      return res.json({ status: "error", message: "DNS lookup failed" });
    }

    const dnsData = await dnsRes.json();

    // Check if any A record points to VPS_IP
    const aRecords = (dnsData.Answer || []).filter(r => r.type === 1); // type 1 = A record
    const pointsToServer = aRecords.some(r => r.data === VPS_IP);

    if (!pointsToServer) {
      return res.json({
        status: "error",
        message: `Domain does not point to this server (${VPS_IP}). Please update your DNS A record.`
      });
    }

    // Assign domain
    data[appName].domain = domain;
    saveData(data);

    // Set cooldown for this IP
    setNginxCooldown(clientIp);

    // Write nginx config file
    const port = parseInt(data[appName].port.split(":")[1]);
    const nginxConfig = `server {\n    server_name ${domain};\n\n    location / {\n        proxy_pass http://${VPS_IP}:${port};\n    }\n}\n`;
    const nginxFile = path.join(NGINX_PATH, `${appName}.conf`);
    fs.writeFileSync(nginxFile, nginxConfig);
    await safeRun("nginx", ["-s", "reload"]).catch(() => {});

    res.json({
      status: "success",
      message: `Domain ${domain} has been assigned to ${appName}`,
      domain
    });

  } catch (e) {
    if (e.name === "AbortError") {
      return res.json({ status: "error", message: "DNS lookup timed out" });
    }
    res.json({ status: "error", message: "DNS lookup error: " + e.toString() });
  }
});

// ── /api/seedomain ───────────────────────────────────────────────────────────
// Returns the domain currently assigned to an app
app.post("/api/seedomain", (req, res) => {
  const { username, password, appName, appPassword } = req.body;

  if (!username || !password || !appName || !appPassword) {
    return res.json({ status: "error", message: "Missing required fields" });
  }

  const creds = loadCredentials();
  const user  = creds.find(c => c.username === username && c.pass === password);
  if (!user) return res.json({ status: "error", message: "Invalid username or password" });

  if (!user.servers.includes(appName)) {
    return res.json({ status: "error", message: "You don't own this app" });
  }

  const data = loadData();
  if (!data[appName]) return res.json({ status: "error", message: "App not found" });
  if (data[appName].password !== appPassword) return res.json({ status: "error", message: "Invalid app password" });

  const domain = data[appName].domain || "";
  res.json({ status: "success", domain });
});

// ── /api/delete-domain ───────────────────────────────────────────────────────
// Removes the custom domain from an app and deletes its nginx config
app.post("/api/delete-domain", async (req, res) => {
  const { username, password, appName, appPassword } = req.body;

  if (!username || !password || !appName || !appPassword) {
    return res.json({ status: "error", message: "Missing required fields" });
  }

  const creds = loadCredentials();
  const user  = creds.find(c => c.username === username && c.pass === password);
  if (!user) return res.json({ status: "error", message: "Invalid username or password" });

  if (!user.servers.includes(appName)) {
    return res.json({ status: "error", message: "You don't own this app" });
  }

  const data = loadData();
  if (!data[appName]) return res.json({ status: "error", message: "App not found" });
  if (data[appName].password !== appPassword) return res.json({ status: "error", message: "Invalid app password" });

  // Remove nginx config if it exists
  const nginxFile = path.join(NGINX_PATH, `${appName}.conf`);
  if (fs.existsSync(nginxFile)) {
    fs.unlinkSync(nginxFile);
    await safeRun("nginx", ["-s", "reload"]).catch(() => {});
  }

  data[appName].domain = "";
  saveData(data);

  res.json({ status: "success", message: `Domain removed from ${appName}` });
});

// ── /api/scan ─────────────────────────────────────────────────────────────────
// Runs a Trivy vulnerability scan on the app's Docker image (premium only)
app.post("/api/scan", async (req, res) => {
  const { username, password, appName, appPassword } = req.body;

  if (!username || !password || !appName || !appPassword) {
    return res.json({ status: "error", message: "Missing required fields" });
  }

  // 10 min cooldown per IP
  const clientIp = req.ip || req.connection.remoteAddress;
  const cooldownRemaining = checkNginxCooldown(clientIp);
  if (cooldownRemaining !== null) {
    return res.json({ status: "error", message: `Please wait ${cooldownRemaining} seconds before scanning again` });
  }

  // Validate account
  const creds = loadCredentials();
  const user  = creds.find(c => c.username === username && c.pass === password);
  if (!user) return res.json({ status: "error", message: "Invalid username or password" });

  if (!user.servers.includes(appName)) {
    return res.json({ status: "error", message: "You don't own this app" });
  }

  // Validate app password
  const data = loadData();
  if (!data[appName]) return res.json({ status: "error", message: "App not found" });
  if (data[appName].password !== appPassword) return res.json({ status: "error", message: "Invalid app password" });

  // Premium only
  if ((data[appName].plan || "free") !== "premium") {
    return res.json({ status: "error", message: "Vulnerability scanning is only available for premium VPS" });
  }

try {
    const output = await safeRun("trivy", [
      "image", 
      "--severity", "HIGH,CRITICAL,MEDIUM,LOW",
      "--no-progress",
      appName
    ]);
    
    setNginxCooldown(clientIp);
    res.json({ 
      status: "success", 
      appName,
      report: output  // Send raw text, not JSON
    });
  } catch (e) {
    res.json({ status: "error", message: "Trivy scan failed: " + e.toString() });
}
});

// ── /api/ssl ─────────────────────────────────────────────────────────────────
// Enables SSL for a premium app via certbot (permanent — cannot be removed once applied)
app.post("/api/ssl", async (req, res) => {
  const { username, password, appName, appPassword } = req.body;

  if (!username || !password || !appName || !appPassword) {
    return res.json({ status: "error", message: "Missing required fields" });
  }

  // 10 min cooldown per IP
  const clientIp = req.ip || req.connection.remoteAddress;
  const cooldownRemaining = checkNginxCooldown(clientIp);
  if (cooldownRemaining !== null) {
    return res.json({ status: "error", message: `Please wait ${cooldownRemaining} seconds before applying SSL again` });
  }

  // Validate account
  const creds = loadCredentials();
  const user  = creds.find(c => c.username === username && c.pass === password);
  if (!user) return res.json({ status: "error", message: "Invalid username or password" });

  if (!user.servers.includes(appName)) {
    return res.json({ status: "error", message: "You don't own this app" });
  }

  // Validate app password
  const data = loadData();
  if (!data[appName]) return res.json({ status: "error", message: "App not found" });
  if (data[appName].password !== appPassword) return res.json({ status: "error", message: "Invalid app password" });

  // Premium only
  if ((data[appName].plan || "free") !== "premium") {
    return res.json({ status: "error", message: "SSL is only available for premium VPS" });
  }

  // SSL already applied — permanent, no removal
  if (data[appName].https === true) {
    return res.json({ status: "error", message: "SSL is already applied to this app" });
  }

  const certName = `${appName}.cloudra.vortexa.cloud`;

  try {
    await safeRun("certbot", [
      "--nginx", "-d", certName,
      "--non-interactive", "--agree-tos",
      "-m", "ssl@cloudra.vortexa.cloud"
    ]);
    data[appName].https = true;
    saveData(data);
    setNginxCooldown(clientIp);
    res.json({ status: "success", message: `SSL enabled for ${certName}`, https: true });
  } catch (e) {
    res.json({ status: "error", message: "Certbot failed: " + e.toString() });
  }
});

// ── /api/blocked ──────────────────────────────────────────────────────────────
// Replaces the blocked IPs array for an app
app.post("/api/blocked", (req, res) => {
  const { username, password, appName, appPassword, blocked } = req.body;

  if (!username || !password || !appName || !appPassword) {
    return res.json({ status: "error", message: "Missing required fields" });
  }

  if (!Array.isArray(blocked)) {
    return res.json({ status: "error", message: "'blocked' must be an array of IPs" });
  }

  // Validate account
  const creds = loadCredentials();
  const user  = creds.find(c => c.username === username && c.pass === password);
  if (!user) return res.json({ status: "error", message: "Invalid username or password" });

  if (!user.servers.includes(appName)) {
    return res.json({ status: "error", message: "You don't own this app" });
  }

  // Validate app password
  const data = loadData();
  if (!data[appName]) return res.json({ status: "error", message: "App not found" });
  if (data[appName].password !== appPassword) return res.json({ status: "error", message: "Invalid app password" });

  // Premium only
  if ((data[appName].plan || "free") !== "premium") {
    return res.json({ status: "error", message: "IP blocking is only available for premium VPS" });
  }

  data[appName].blocked = blocked;
  saveData(data);

  res.json({ status: "success", message: `Blocked list updated for ${appName}`, blocked });
});

// ── /api/exec ─────────────────────────────────────────────────────────────────
// Executes a single shell command inside the app's container and returns output
app.post("/api/exec", async (req, res) => {
  const { username, password, appName, appPassword, command } = req.body;

  if (!username || !password || !appName || !appPassword || !command) {
    return res.json({ status: "error", message: "Missing required fields" });
  }

  // Validate account
  const creds = loadCredentials();
  const user = creds.find(c => c.username === username && c.pass === password);
  if (!user) return res.json({ status: "error", message: "Invalid username or password" });

  if (!user.servers.includes(appName)) {
    return res.json({ status: "error", message: "You don't own this app" });
  }

  // Validate app password
  const data = loadData();
  if (!data[appName]) return res.json({ status: "error", message: "App not found" });
  if (data[appName].password !== appPassword) return res.json({ status: "error", message: "Invalid app password" });

  // Premium only
  if ((data[appName].plan || "free") !== "premium") {
    return res.json({ status: "error", message: "Terminal is only available for premium VPS" });
  }

  // Block dangerous commands
  const dangerous = /^\s*(rm\s+-rf\s+\/|mkfs|dd\s+if=|:(){ :|:& };:)/;
  if (dangerous.test(command)) {
    return res.json({ status: "error", message: "Command blocked for safety" });
  }

  try {
    const output = await new Promise((resolve, reject) => {
      execFile("docker", ["exec", appName, "/bin/sh", "-c", command], {
        timeout: 30000,
        maxBuffer: 1024 * 512
      }, (err, stdout, stderr) => {
        // Return both stdout and stderr; non-zero exit is not an error for us
        const combined = (stdout || "") + (stderr || "");
        resolve({ output: combined, exitCode: err ? (err.code || 1) : 0 });
      });
    });
    res.json({ status: "success", output: output.output, exitCode: output.exitCode });
  } catch (e) {
    res.json({ status: "error", message: "Exec failed: " + e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// RUNTIME HELPERS for redeploy
// ─────────────────────────────────────────────────────────────────────────────

function getKillCommand(language) {
  if (language.startsWith("nodejs") || language === "bun") return "node";
  if (language === "ts" || language.startsWith("ts"))       return "node";
  if (language === "deno")                                   return "deno";
  if (language.startsWith("python"))                        return "python3";
  if (language.startsWith("go"))                            return "go";
  if (language === "ruby")                                   return "ruby";
  if (language === "php")                                    return "php";
  if (language === "java")                                   return "java";
  if (language === "dotnet")                                 return "dotnet";
  if (language === "elixir")                                 return "elixir";
  return null;
}

function getRunCommand(language, startFile) {
  const f = `/app/${startFile}`;
  if (language.startsWith("nodejs"))                        return `node ${f}`;
  if (language === "ts" || language.startsWith("ts"))       return `npx ts-node ${f}`;
  if (language.startsWith("python"))                        return `python3 ${f}`;
  if (language.startsWith("go"))                            return `go run ${f}`;
  if (language === "ruby")                                   return `ruby ${f}`;
  if (language === "php")                                    return `php ${f}`;
  if (language === "bun")                                    return `bun run ${f}`;
  if (language === "deno")                                   return `deno run --allow-all ${f}`;
  if (language === "java")                                   return `java -jar ${f}`;
  if (language === "dotnet")                                 return `dotnet ${f}`;
  if (language === "elixir")                                 return `elixir ${f}`;
  return null;
}

function getPackageInstallCmd(language, pkgs) {
  if (!pkgs || pkgs.length === 0) return null;
  const p = pkgs.filter(Boolean).join(" ");
  if (!p) return null;
  if (language.startsWith("nodejs") || language === "ts" || language.startsWith("ts")) return `npm install ${p}`;
  if (language === "bun")            return `bun add ${p}`;
  if (language === "deno")           return null; // deno imports inline
  if (language.startsWith("python")) return `pip install --no-cache-dir ${p}`;
  if (language.startsWith("go"))     return `go get ${p}`;
  if (language === "ruby")           return `gem install ${p}`;
  if (language === "php")            return `composer require --no-interaction ${p}`;
  if (language === "elixir")         return pkgs.filter(Boolean).map(x => `mix archive.install hex ${x} --force`).join(" && ");
  return null;
}

// Sanitize a user-supplied file path — must stay within /app
function sanitizeFilePath(userPath) {
  const normalized = path.posix.normalize(userPath.replace(/\\/g, "/"));
  // Reject anything that tries to escape /app
  if (normalized.includes("..")) return null;
  // Strip any leading slash so we can join safely
  return normalized.replace(/^\/+/, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// FILE SYSTEM APIs (available for all plans — free & premium)
// Auth: username, password, appName, appPassword
// All paths are relative to /app inside the container.
// ─────────────────────────────────────────────────────────────────────────────

// ── /api/fs/create ────────────────────────────────────────────────────────────
// Creates a file (and any parent folders) inside the container.
// Body: { username, password, appName, appPassword, filePath }
// filePath examples: "index.js", "src/utils/helper.py", "a/b/c/main.go"
app.post("/api/fs/create", async (req, res) => {
  const { username, password, appName, appPassword, filePath } = req.body;

  if (!username || !password || !appName || !appPassword || !filePath) {
    return res.json({ status: "error", message: "Missing required fields" });
  }

  const safePath = sanitizeFilePath(filePath);
  if (!safePath) return res.json({ status: "error", message: "Invalid file path" });

  const creds = loadCredentials();
  const user  = creds.find(c => c.username === username && c.pass === password);
  if (!user) return res.json({ status: "error", message: "Invalid username or password" });
  if (!user.servers.includes(appName)) return res.json({ status: "error", message: "You don't own this app" });

  const data = loadData();
  if (!data[appName]) return res.json({ status: "error", message: "App not found" });
  if (data[appName].password !== appPassword) return res.json({ status: "error", message: "Invalid app password" });

  try {
    const fullPath = `/app/${safePath}`;
    const dirPath  = path.posix.dirname(fullPath);
    await safeRun("docker", ["exec", appName, "/bin/sh", "-c",
      `mkdir -p "${dirPath}" && touch "${fullPath}"`
    ]);
    res.json({ status: "success", message: `File created: ${safePath}`, filePath: safePath });
  } catch (e) {
    res.json({ status: "error", message: "Failed to create file: " + e.toString() });
  }
});

// ── /api/fs/list ──────────────────────────────────────────────────────────────
// Lists every file inside /app recursively (folders shown as paths).
// Body: { username, password, appName, appPassword }
app.post("/api/fs/list", async (req, res) => {
  const { username, password, appName, appPassword } = req.body;

  if (!username || !password || !appName || !appPassword) {
    return res.json({ status: "error", message: "Missing required fields" });
  }

  const creds = loadCredentials();
  const user  = creds.find(c => c.username === username && c.pass === password);
  if (!user) return res.json({ status: "error", message: "Invalid username or password" });
  if (!user.servers.includes(appName)) return res.json({ status: "error", message: "You don't own this app" });

  const data = loadData();
  if (!data[appName]) return res.json({ status: "error", message: "App not found" });
  if (data[appName].password !== appPassword) return res.json({ status: "error", message: "Invalid app password" });

  try {
    // find returns paths like /app/src/index.js — strip the /app/ prefix
    const raw = await safeRun("docker", ["exec", appName, "/bin/sh", "-c",
      "find /app -not -path '/app/node_modules/*' -not -path '/app/.git/*' -type f | sort"
    ]);
    const files = raw
      .split("\n")
      .map(f => f.trim())
      .filter(Boolean)
      .map(f => f.replace(/^\/app\//, ""));
    res.json({ status: "success", files });
  } catch (e) {
    res.json({ status: "error", message: "Failed to list files: " + e.toString() });
  }
});

// ── /api/fs/read ──────────────────────────────────────────────────────────────
// Returns the content of a file as a UTF-8 string.
// Body: { username, password, appName, appPassword, filePath }
app.post("/api/fs/read", async (req, res) => {
  const { username, password, appName, appPassword, filePath } = req.body;

  if (!username || !password || !appName || !appPassword || !filePath) {
    return res.json({ status: "error", message: "Missing required fields" });
  }

  const safePath = sanitizeFilePath(filePath);
  if (!safePath) return res.json({ status: "error", message: "Invalid file path" });

  const creds = loadCredentials();
  const user  = creds.find(c => c.username === username && c.pass === password);
  if (!user) return res.json({ status: "error", message: "Invalid username or password" });
  if (!user.servers.includes(appName)) return res.json({ status: "error", message: "You don't own this app" });

  const data = loadData();
  if (!data[appName]) return res.json({ status: "error", message: "App not found" });
  if (data[appName].password !== appPassword) return res.json({ status: "error", message: "Invalid app password" });

  try {
    const content = await safeRun("docker", ["exec", appName, "cat", `/app/${safePath}`]);
    res.json({ status: "success", filePath: safePath, content });
  } catch (e) {
    res.json({ status: "error", message: "Failed to read file: " + e.toString() });
  }
});

// ── /api/fs/save ──────────────────────────────────────────────────────────────
// Writes (overwrites) the content of a file inside the container.
// Body: { username, password, appName, appPassword, filePath, content }
app.post("/api/fs/save", async (req, res) => {
  const { username, password, appName, appPassword, filePath, content } = req.body;

  if (!username || !password || !appName || !appPassword || !filePath || content === undefined) {
    return res.json({ status: "error", message: "Missing required fields" });
  }

  const safePath = sanitizeFilePath(filePath);
  if (!safePath) return res.json({ status: "error", message: "Invalid file path" });

  const creds = loadCredentials();
  const user  = creds.find(c => c.username === username && c.pass === password);
  if (!user) return res.json({ status: "error", message: "Invalid username or password" });
  if (!user.servers.includes(appName)) return res.json({ status: "error", message: "You don't own this app" });

  const data = loadData();
  if (!data[appName]) return res.json({ status: "error", message: "App not found" });
  if (data[appName].password !== appPassword) return res.json({ status: "error", message: "Invalid app password" });

  // Write to a temp file on host, then docker cp into the container — binary-safe
  const tmpFile = `/tmp/cloudra_fs_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  try {
    fs.writeFileSync(tmpFile, content, "utf-8");
    const fullPath = `/app/${safePath}`;
    const dirPath  = path.posix.dirname(fullPath);
    // Ensure parent directory exists
    await safeRun("docker", ["exec", appName, "/bin/sh", "-c", `mkdir -p "${dirPath}"`]);
    // Copy the temp file into the container
    await safeRun("docker", ["cp", tmpFile, `${appName}:${fullPath}`]);
    res.json({ status: "success", message: `File saved: ${safePath}`, filePath: safePath });
  } catch (e) {
    res.json({ status: "error", message: "Failed to save file: " + e.toString() });
  } finally {
    fs.unlink(tmpFile, () => {});
  }
});

// ── /api/fs/delete ────────────────────────────────────────────────────────────
// Deletes a file (or empty directory) inside the container.
// Body: { username, password, appName, appPassword, filePath }
app.post("/api/fs/delete", async (req, res) => {
  const { username, password, appName, appPassword, filePath } = req.body;

  if (!username || !password || !appName || !appPassword || !filePath) {
    return res.json({ status: "error", message: "Missing required fields" });
  }

  const safePath = sanitizeFilePath(filePath);
  if (!safePath) return res.json({ status: "error", message: "Invalid file path" });

  const creds = loadCredentials();
  const user  = creds.find(c => c.username === username && c.pass === password);
  if (!user) return res.json({ status: "error", message: "Invalid username or password" });
  if (!user.servers.includes(appName)) return res.json({ status: "error", message: "You don't own this app" });

  const data = loadData();
  if (!data[appName]) return res.json({ status: "error", message: "App not found" });
  if (data[appName].password !== appPassword) return res.json({ status: "error", message: "Invalid app password" });

  try {
    await safeRun("docker", ["exec", appName, "rm", "-rf", `/app/${safePath}`]);
    res.json({ status: "success", message: `Deleted: ${safePath}`, filePath: safePath });
  } catch (e) {
    res.json({ status: "error", message: "Failed to delete: " + e.toString() });
  }
});

// ── /api/fs/rename ────────────────────────────────────────────────────────────
// Renames (or moves) a file inside the container.
// Body: { username, password, appName, appPassword, oldPath, newPath }
app.post("/api/fs/rename", async (req, res) => {
  const { username, password, appName, appPassword, oldPath, newPath } = req.body;

  if (!username || !password || !appName || !appPassword || !oldPath || !newPath) {
    return res.json({ status: "error", message: "Missing required fields" });
  }

  const safeOld = sanitizeFilePath(oldPath);
  const safeNew = sanitizeFilePath(newPath);
  if (!safeOld || !safeNew) return res.json({ status: "error", message: "Invalid file path" });

  const creds = loadCredentials();
  const user  = creds.find(c => c.username === username && c.pass === password);
  if (!user) return res.json({ status: "error", message: "Invalid username or password" });
  if (!user.servers.includes(appName)) return res.json({ status: "error", message: "You don't own this app" });

  const data = loadData();
  if (!data[appName]) return res.json({ status: "error", message: "App not found" });
  if (data[appName].password !== appPassword) return res.json({ status: "error", message: "Invalid app password" });

  try {
    const newFullPath = `/app/${safeNew}`;
    const newDir      = path.posix.dirname(newFullPath);
    await safeRun("docker", ["exec", appName, "/bin/sh", "-c",
      `mkdir -p "${newDir}" && mv "/app/${safeOld}" "${newFullPath}"`
    ]);
    res.json({ status: "success", message: `Renamed ${safeOld} → ${safeNew}`, oldPath: safeOld, newPath: safeNew });
  } catch (e) {
    res.json({ status: "error", message: "Failed to rename: " + e.toString() });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/redeploy — re-run app inside the existing container (no new container)
// Installs packages, kills the old process, starts the new file.
// Works for apps created via /api/create-vps or /api/deploy.
// Body: { username, password, appName, appPassword, language, packages, startFile }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/redeploy", async (req, res) => {
  const { username, password, appName, appPassword, language, packages, startFile } = req.body;
  let logs = [];

  if (!username || !password || !appName || !appPassword || !language || !startFile) {
    return res.json({ status: "error", message: "Missing required fields", logs });
  }

  if (!IMAGES[language]) {
    return res.json({ status: "error", message: `Unsupported runtime: ${language}. Supported: ${Object.keys(IMAGES).join(", ")}`, logs });
  }

  // Validate account
  const creds = loadCredentials();
  const user  = creds.find(c => c.username === username && c.pass === password);
  if (!user) return res.json({ status: "error", message: "Invalid username or password", logs });
  if (!user.servers.includes(appName)) return res.json({ status: "error", message: "You don't own this app", logs });

  // Validate app password
  const data = loadData();
  if (!data[appName]) return res.json({ status: "error", message: "App not found", logs });
  if (data[appName].password !== appPassword) return res.json({ status: "error", message: "Invalid app password", logs });

  try {
    // Step 1: Install packages if provided
    const extraPkgs = (packages || []).filter(Boolean);
    if (extraPkgs.length > 0) {
      const installCmd = getPackageInstallCmd(language, extraPkgs);
      if (installCmd) {
        try {
          const installOut = await safeRun("docker", ["exec", appName, "/bin/sh", "-c", `cd /app && ${installCmd}`]);
          logs.push(installOut);
          logs.push(`Packages installed: ${extraPkgs.join(", ")}`);
        } catch (e) {
          logs.push(`Warning: Package install issue — ${e.toString()}`);
        }
      }
    }

    // Step 2: Kill existing runtime process (ignore error if nothing was running)
    const killProc = getKillCommand(language);
    if (killProc) {
      await safeRun("docker", ["exec", appName, "/bin/sh", "-c",
        `pkill -f "${killProc}" 2>/dev/null || true`
      ]).catch(() => {});
      // Small wait so port is freed before restarting
      await new Promise(r => setTimeout(r, 500));
      logs.push(`Stopped existing ${killProc} process`);
    }

    // Step 3: Start the new file in background (stdout/stderr piped to container logs)
    const runCmd = getRunCommand(language, startFile);
    if (!runCmd) {
      return res.json({ status: "error", message: `Cannot determine run command for runtime: ${language}`, logs });
    }

    await safeRun("docker", ["exec", "-d", appName, "/bin/sh", "-c",
      `cd /app && ${runCmd} >> /proc/1/fd/1 2>&1`
    ]);
    logs.push(`Started: ${runCmd}`);

    data[appName].lastStart = nowISO();
    data[appName].status    = "active";
    saveData(data);

    res.json({ status: "success", message: `App ${appName} redeployed successfully`, startFile, logs });
  } catch (e) {
    logs.push(e.toString());
    res.json({ status: "error", message: "Redeploy failed", logs });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/create-vps — spin up a container for an already-claimed VPS
// The app MUST already exist in ports.json (claimed via /api/deploy first).
// If the container already exists it returns an error.
// If the app is not in ports.json it returns an error (deploy first).
// Body: { username, password, appName, appPassword, language }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/create-vps", async (req, res) => {
  const { username, password, appName, appPassword, language } = req.body;

  if (!username || !password || !appName || !appPassword || !language) {
    return res.json({ status: "error", message: "Missing required fields" });
  }

  if (!IMAGES[language]) {
    return res.json({ status: "error", message: `Unsupported runtime: ${language}. Supported: ${Object.keys(IMAGES).join(", ")}` });
  }

  // Validate account
  const creds     = loadCredentials();
  const userIndex = creds.findIndex(c => c.username === username && c.pass === password);
  if (userIndex === -1) return res.json({ status: "error", message: "Invalid username or password" });

  const user = creds[userIndex];
  const data = loadData();

  // App must already exist in ports.json and be owned by this user
  if (!data[appName] || !user.servers.includes(appName)) {
    return res.json({ status: "error", message: "App not found. Please claim your free VPS first via /api/deploy" });
  }

  // Validate app password
  if (data[appName].password !== appPassword) {
    return res.json({ status: "error", message: "Invalid app password" });
  }

  // Check if container already exists
  try {
    await safeRun("docker", ["inspect", "--format", "{{.Name}}", appName]);
    return res.json({ status: "error", message: "Container already exists for this app" });
  } catch {
    // Good — no container running, proceed
  }

  const port    = parseInt(data[appName].port.split(":")[1]);
  const ram     = data[appName].ram     || FREE_RAM;
  const cpu     = data[appName].cpu     || FREE_CPU;

  // Spin up the container
  try {
    await runQueued(async () => {
      // Pull image (ignore error if already cached)
      await safeRun("docker", ["pull", IMAGES[language]]).catch(() => {});

      // Persistent idle PID 1 — use /api/fs/* to add files, /api/redeploy to run
      await safeRun("docker", [
        "run", "-d",
        "--name",   appName,
        "-p",       `${port}:${port}`,
        `--memory=${ram}`,
        `--cpus=${cpu}`,
        "--pids-limit=200",
        "--security-opt=no-new-privileges",
        "--cap-drop=ALL",
        "--cap-add=NET_BIND_SERVICE",
        "--ulimit", "nproc=200",
        "--ulimit", "nofile=1024",
        "--tmpfs",  "/tmp:rw,size=100m,noexec",
        "--restart=on-failure:2",
        "--network=bridge",
        IMAGES[language],
        "tail", "-f", "/dev/null"
      ]);

      // Ensure /app directory exists inside the container
      await safeRun("docker", ["exec", appName, "/bin/sh", "-c", "mkdir -p /app"]).catch(() => {});
    });

    // Mark active with fresh lastStart
    data[appName].lastStart = nowISO();
    data[appName].status    = "active";
    saveData(data);

    res.json({
      status:  "success",
      message: `VPS ${appName} container created. Use /api/fs/* to add files, then /api/redeploy to run them.`,
      app: { name: appName, port, url: `http://${VPS_IP}:${port}`, language }
    });

  } catch (e) {
    res.json({ status: "error", message: "Failed to create VPS: " + e.toString() });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
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

const pty = require("node-pty");

wss.on("connection", (ws) => {
  let ptyProc = null;
  let authenticated = false;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return ws.close(1008, "Invalid JSON"); }

    if (!authenticated) {
      const { username, password, appName, appPassword } = msg;

      if (!username || !password || !appName || !appPassword) {
        ws.send(JSON.stringify({ type: "error", message: "Missing credentials" }));
        return ws.close(1008, "Missing credentials");
      }

      const creds = loadCredentials();
      const user = creds.find(c => c.username === username && c.pass === password);
      if (!user) {
        ws.send(JSON.stringify({ type: "error", message: "Invalid username or password" }));
        return ws.close(1008, "Auth failed");
      }

      if (!user.servers.includes(appName)) {
        ws.send(JSON.stringify({ type: "error", message: "You don't own this app" }));
        return ws.close(1008, "Not owner");
      }

      const data = loadData();
      if (!data[appName]) {
        ws.send(JSON.stringify({ type: "error", message: "App not found" }));
        return ws.close(1008, "App not found");
      }

      if (data[appName].password !== appPassword) {
        ws.send(JSON.stringify({ type: "error", message: "Invalid app password" }));
        return ws.close(1008, "Auth failed");
      }

      if ((data[appName].plan || "free") !== "premium") {
        ws.send(JSON.stringify({ type: "error", message: "Terminal is only available for premium VPS" }));
        return ws.close(1008, "Premium only");
      }

      try {
        ptyProc = pty.spawn("docker", ["exec", "-it", appName, "/bin/sh"], {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          env: process.env
        });
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", message: "Failed to spawn terminal: " + err.message }));
        return ws.close(1011, "Spawn failed");
      }

      authenticated = true;
      ws.send(JSON.stringify({ type: "ready", message: "Connected to " + appName }));

      ptyProc.onData((data) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "output", data }));
        }
      });

      ptyProc.onExit(({ exitCode }) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "exit", code: exitCode }));
          ws.close();
        }
      });

      return;
    }

    if (msg.type === "input" && ptyProc) {
      ptyProc.write(msg.data);
    }

    if (msg.type === "resize" && ptyProc) {
      const cols = parseInt(msg.cols) || 80;
      const rows = parseInt(msg.rows) || 24;
      ptyProc.resize(cols, rows);
    }
  });

  ws.on("close", () => {
    if (ptyProc) { ptyProc.kill(); ptyProc = null; }
  });

  ws.on("error", () => {
    if (ptyProc) { ptyProc.kill(); ptyProc = null; }
  });
});

server.listen(3560, "0.0.0.0", () => console.log("Backend running on port 3560"));
