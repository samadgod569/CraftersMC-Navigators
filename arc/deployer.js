const express = require("express");
const fs = require("fs");
const { execFile } = require("child_process");
const path = require("path");
const bodyParser = require("body-parser");

const app = express();
app.set("trust proxy", 1);
app.use(bodyParser.json());

const BASE_PATH = "/platform/apps";
const DATA_PATH = "/platform/data/ports.json";
const CRED_PATH = "/platform/data/credentials.json";
const VPS_IP    = "45.137.70.54";

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

const RESERVED_APP_NAMES = ["cloudra", "vortexa"];

function validateAppName(name) {
  if (typeof name !== "string" || name.length === 0) {
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

function buildDockerfile(image, language, packages, startFile) {
  const extraPkgs = packages?.filter(Boolean) ?? [];
  const isNode = language.startsWith("nodejs");
  const isTs   = language === "ts" || language.startsWith("ts");

  let df = `FROM ${image}\nWORKDIR /app\nCOPY . .\n\n`;
  df += `RUN useradd -m appuser 2>/dev/null || adduser -D appuser\n\n`;

  if (isNode || isTs) {
    df += `RUN if [ -f package.json ]; then npm install; fi\n`;
    if (extraPkgs.length) df += `RUN npm install ${extraPkgs.join(" ")}\n`;
    if (isTs) df += `RUN npm install -g ts-node typescript\n`;
    df += `RUN mkdir -p /home/appuser/.npm && chown -R appuser:appuser /home/appuser/.npm\n`;
  } else if (language.startsWith("python")) {
    df += `RUN if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; fi\n`;
    if (extraPkgs.length) df += `RUN pip install --no-cache-dir ${extraPkgs.join(" ")}\n`;
    df += `RUN mkdir -p /home/appuser/.cache/pip && chown -R appuser:appuser /home/appuser/.cache\n`;
  } else if (language.startsWith("go")) {
    df += `RUN if [ -f go.mod ]; then go mod download; fi\n`;
    if (extraPkgs.length) df += `RUN go get ${extraPkgs.join(" ")}\n`;
    df += `RUN mkdir -p /home/appuser/.cache/go-build /home/appuser/go && chown -R appuser:appuser /home/appuser/.cache /home/appuser/go\n`;
    df += `ENV GOPATH=/home/appuser/go\n`;
    df += `ENV GOCACHE=/home/appuser/.cache/go-build\n`;
  } else if (language === "ruby") {
    df += `RUN if [ -f Gemfile ]; then bundle install; fi\n`;
    if (extraPkgs.length) df += `RUN gem install ${extraPkgs.join(" ")}\n`;
    df += `RUN mkdir -p /home/appuser/.gem && chown -R appuser:appuser /home/appuser/.gem\n`;
  } else if (language === "php") {
    df += `RUN apt-get update -y && apt-get install -y --no-install-recommends composer && rm -rf /var/lib/apt/lists/*\n`;
    df += `RUN if [ -f composer.json ]; then composer install --no-interaction --no-dev --optimize-autoloader; fi\n`;
    if (extraPkgs.length) df += `RUN composer require --no-interaction ${extraPkgs.join(" ")}\n`;
    df += `RUN mkdir -p /home/appuser/.composer && chown -R appuser:appuser /home/appuser/.composer\n`;
  } else if (language === "bun") {
    df += `RUN if [ -f package.json ]; then bun install; fi\n`;
    if (extraPkgs.length) df += `RUN bun add ${extraPkgs.join(" ")}\n`;
    df += `RUN mkdir -p /home/appuser/.bun && chown -R appuser:appuser /home/appuser/.bun\n`;
  } else if (language === "rust") {
    df += `RUN mkdir -p /home/appuser/.cargo && chown -R appuser:appuser /home/appuser/.cargo\n`;
    df += `ENV CARGO_HOME=/home/appuser/.cargo\n`;
    df += `RUN cargo build --release\n`;
  } else if (language === "java") {
    df += `RUN apt-get update -y && apt-get install -y --no-install-recommends maven && rm -rf /var/lib/apt/lists/*\n`;
    df += `RUN if [ -f pom.xml ]; then mvn install -DskipTests --no-transfer-progress; fi\n`;
    df += `RUN mkdir -p /home/appuser/.m2 && chown -R appuser:appuser /home/appuser/.m2\n`;
  } else if (language === "dotnet") {
    df += `ENV DOTNET_CLI_TELEMETRY_OPTOUT=1\n`;
    df += `ENV NUGET_PACKAGES=/home/appuser/.nuget/packages\n`;
    df += `RUN if [ -f *.csproj ] 2>/dev/null || ls *.csproj 2>/dev/null; then dotnet restore; fi\n`;
    df += `RUN mkdir -p /home/appuser/.dotnet /home/appuser/.nuget && chown -R appuser:appuser /home/appuser/.dotnet /home/appuser/.nuget\n`;
  } else if (language === "elixir") {
    df += `RUN mix local.hex --force && mix local.rebar --force\n`;
    df += `RUN if [ -f mix.exs ]; then mix deps.get; fi\n`;
    if (extraPkgs.length) extraPkgs.forEach(p => { df += `RUN mix archive.install hex ${p} --force\n`; });
    df += `RUN mkdir -p /home/appuser/.mix /home/appuser/.hex && chown -R appuser:appuser /home/appuser/.mix /home/appuser/.hex\n`;
  } else if (language === "deno") {
    df += `ENV DENO_DIR=/home/appuser/.cache/deno\n`;
    df += `RUN deno cache ${startFile} 2>/dev/null || true\n`;
    df += `RUN mkdir -p /home/appuser/.cache/deno && chown -R appuser:appuser /home/appuser/.cache\n`;
  }

  df += `\nRUN chown -R appuser:appuser /app\n`;
  df += `USER appuser\n\n`;

  if      (isNode)                        df += `CMD ["node", "${startFile}"]\n`;
  else if (isTs)                          df += `CMD ["npx", "ts-node", "${startFile}"]\n`;
  else if (language.startsWith("python")) df += `CMD ["python3", "${startFile}"]\n`;
  else if (language.startsWith("go"))     df += `CMD ["go", "run", "${startFile}"]\n`;
  else if (language === "ruby")           df += `CMD ["ruby", "${startFile}"]\n`;
  else if (language === "php")            df += `CMD ["php", "${startFile}"]\n`;
  else if (language === "rust")           df += `CMD ["./target/release/${startFile}"]\n`;
  else if (language === "java")           df += `CMD ["java", "-jar", "${startFile}"]\n`;
  else if (language === "dotnet")         df += `CMD ["dotnet", "${startFile}"]\n`;
  else if (language === "elixir")         df += `CMD ["elixir", "${startFile}"]\n`;
  else if (language === "bun")            df += `CMD ["bun", "run", "${startFile}"]\n`;
  else if (language === "deno")           df += `CMD ["deno", "run", "--allow-all", "${startFile}"]\n`;

  return df;
}

// ── /api/deploy ───────────────────────────────────────────────────────────────
app.post("/api/deploy", async (req, res) => {
  const { username, password, appName, appPassword, repo, zipUrl, language, packages, startFile, key } = req.body;
  let logs = [];

  if (!username || !password || !appName || !appPassword || (!repo && !zipUrl) || !language || !startFile) {
    return res.json({ status: "error", message: "Missing required fields", logs });
  }
if(key != "*()+!") return res.json({ status: "error", message: "Invalid key"});
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
    let newPort = 4000 + totalApps;
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
      storage: FREE_STORAGE
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
      "--restart=always",
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
      storage
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
      storage: ex.storage || FREE_STORAGE
    };
    saveData(data);

    res.json({ status: "error", message: "Deployment failed", logs });
  }
});

app.listen(8067, "0.0.0.0", () => console.log("Backend running on port 3560"));
