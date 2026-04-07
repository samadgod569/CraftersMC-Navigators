const express = require("express");
const fs = require("fs");
const { execFile } = require("child_process");
const path = require("path");
const bodyParser = require("body-parser");

const app = express();
app.set("trust proxy", 1);
app.use(bodyParser.json());

const BASE_PATH  = "/platform/apps";
const DATA_PATH  = "/platform/data/ports.json";
const CRED_PATH  = "/platform/data/credentials.json";
const PAGES_PATH = "/platform/pages";
const VPS_IP     = "45.137.70.54";

const MS_1H   = 60 * 60 * 1000;
const MS_24H  = 24  * MS_1H;
const MS_72H  = 72  * MS_1H;
const MS_30D  = 30  * 24 * MS_1H;
const MS_35D  = 35  * 24 * MS_1H;

const IMAGES = {
  nodejs:    "node:20",
  nodejs18:  "node:18",
  nodejs16:  "node:16",
  python:    "python:3.12",
  python310: "python:3.10",
  python39:  "python:3.9",
  go:        "golang:1.22",
  go121:     "golang:1.21",
  ts:        "node:20",
  ts18:      "node:18",
  bun:       "oven/bun:latest",
  deno:      "denoland/deno:latest",
  ruby:      "ruby:3.3",
  php:       "php:8.3-cli",
  rust:      "rust:1.78",
  java:      "eclipse-temurin:21",
  dotnet:    "mcr.microsoft.com/dotnet/sdk:8.0",
  elixir:    "elixir:1.16",
};

function safeRun(cmd, args = []) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30000 }, (err, stdout, stderr) => {
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
  if (data[appName][0] !== password) return { ok: false, msg: "Invalid password" };
  return { ok: true };
}

function isValidName(name) {
  return /^[a-zA-Z0-9_-]+$/.test(name);
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

async function purgeApp(appName) {
  await safeRun("docker", ["rm", "-f", appName]).catch(() => {});
  await safeRun("docker", ["rmi", "-f", appName]).catch(() => {});
  await safeRun("rm", ["-rf", path.join(BASE_PATH, appName)]).catch(() => {});
}

function buildDockerfile(image, language, packages, startFile) {
  let df = `FROM ${image}\nWORKDIR /app\nCOPY . .\n\nRUN useradd -m appuser\n`;

  if (language.startsWith("nodejs") || language === "ts" || language.startsWith("ts")) {
    packages?.forEach(p => df += `RUN npm install ${p}\n`);
    if (language === "ts" || language.startsWith("ts")) df += `RUN npm install -g ts-node typescript\n`;
  } else if (language.startsWith("python")) {
    packages?.forEach(p => df += `RUN pip install ${p}\n`);
  } else if (language.startsWith("go")) {
    packages?.forEach(p => df += `RUN go install ${p}@latest\n`);
  } else if (language === "ruby") {
    packages?.forEach(p => df += `RUN gem install ${p}\n`);
  } else if (language === "php") {
    if (packages?.length) df += `RUN apt-get update -y && apt-get install -y composer\n`;
    packages?.forEach(p => df += `RUN composer require ${p}\n`);
  } else if (language === "bun") {
    packages?.forEach(p => df += `RUN bun add ${p}\n`);
  } else if (language === "rust") {
    df += `RUN cargo build --release\n`;
  } else if (language === "java") {
    df += `RUN apt-get update -y && apt-get install -y maven\n`;
  }

  df += `USER appuser\n`;

  if (language.startsWith("nodejs")) df += `CMD ["node","${startFile}"]\n`;
  else if (language === "ts" || language.startsWith("ts")) df += `CMD ["npx","ts-node","${startFile}"]\n`;
  else if (language.startsWith("python")) df += `CMD ["python3","${startFile}"]\n`;
  else if (language.startsWith("go")) df += `CMD ["go","run","${startFile}"]\n`;
  else if (language === "ruby")   df += `CMD ["ruby","${startFile}"]\n`;
  else if (language === "php")    df += `CMD ["php","${startFile}"]\n`;
  else if (language === "rust")   df += `CMD ["./target/release/${startFile}"]\n`;
  else if (language === "java")   df += `CMD ["java","-jar","${startFile}"]\n`;
  else if (language === "dotnet") df += `CMD ["dotnet","${startFile}"]\n`;
  else if (language === "elixir") df += `CMD ["elixir","${startFile}"]\n`;
  else if (language === "bun")    df += `CMD ["bun","run","${startFile}"]\n`;
  else if (language === "deno")   df += `CMD ["deno","run","--allow-all","${startFile}"]\n`;

  return df;
}

async function runMonitor() {
  const data = loadData();
  const creds = loadCredentials();
  let dataDirty = false;
  let credsDirty = false;

  for (const [appName, entry] of Object.entries(data)) {
    const plan      = entry[3] || "free";
    const status    = entry[5];
    const createdAt = entry[6];

    if (plan === "free") {
      const lastStart = entry[4];
      if (!lastStart) continue;

      const elapsed = Date.now() - new Date(lastStart).getTime();

      if (elapsed >= MS_72H) {
        await purgeApp(appName);
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
        entry[5] = "suspended";
        dataDirty = true;
        console.log(`[monitor] SUSPENDED ${appName} | plan=free | elapsed=${Math.round(elapsed / MS_1H)}h`);
      }

    } else if (plan === "premium") {
      if (!createdAt) continue;

      const elapsed = Date.now() - new Date(createdAt).getTime();

      if (elapsed >= MS_35D) {
        await purgeApp(appName);
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
        entry[5] = "expired";
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

  if (!isValidName(appName)) {
    return res.json({ status: "error", message: "Invalid app name" });
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

    const usedPorts = Object.values(data).map(v => parseInt(v[1].split(":")[1]));
    const totalApps = Object.keys(data).length;
    let newPort = 4000 + totalApps;
    while (usedPorts.includes(newPort)) newPort++;

    data[appName] = [appPassword, `${VPS_IP}:${newPort}`, [], "free", nowISO(), "active", null];
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

  if (data[appName] && data[appName][0] !== appPassword) {
    return res.json({ status: "error", message: "Invalid app password", logs });
  }

  const existingEntry = data[appName] || [];
  const plan          = existingEntry[3] || "free";
  const existingStatus = existingEntry[5];

  if (plan === "premium" && existingStatus === "expired") {
    return res.json({ status: "error", message: "This VPS has expired and cannot be redeployed", logs });
  }

  const existingCreatedAt = existingEntry[6] || null;
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

    const port = parseInt(data[appName][1].split(":")[1]);

    logs.push(await safeRun("docker", [
      "run", "-d",
      "--name", appName,
      "-p", `${port}:${port}`,
      "--memory=512m",
      "--cpus=0.2",
      "--pids-limit=100",
      "--storage-opt", "size=2G",
      "--read-only",
      "--tmpfs", "/tmp:rw,size=100m",
      "--security-opt=no-new-privileges",
      "--security-opt", "seccomp=unconfined",
      "--cap-drop", "ALL",
      "--ulimit", "nproc=100",
      "--ulimit", "nofile=1024",
      "--restart=always",
      appName
    ]));

    logs.push(`Container started on port ${port}`);

    const resolvedCreatedAt = plan === "premium"
      ? (existingCreatedAt || nowISO())
      : null;

    data[appName] = [appPassword, `${VPS_IP}:${port}`, logs, plan, nowISO(), "active", resolvedCreatedAt];
    saveData(data);

    res.json({
      status: "success",
      app: { name: appName, port, url: `http://${VPS_IP}:${port}` },
      logs
    });

  } catch (err) {
    logs.push(err.toString());
    const ex = data[appName] || [];
    data[appName] = [appPassword, ex[1] || null, logs, ex[3] || "free", ex[4] || nowISO(), "error", ex[6] || null];
    saveData(data);

    res.json({ status: "error", message: "Deployment failed", logs });
  }
});

app.post("/api/stop", async (req, res) => {
  const { appName, password } = req.body;
  const data = loadData();

  const v = validate(appName, password, data);
  if (!v.ok) return res.json({ status: "error", message: v.msg });

  const plan   = data[appName][3] || "free";
  const status = data[appName][5];

  if (plan === "premium" && status === "expired") {
    return res.json({ status: "error", message: "This VPS has expired and cannot be controlled" });
  }

  try {
    const out = await safeRun("docker", ["stop", appName]);
    data[appName][5] = "stopped";
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

  const plan   = data[appName][3] || "free";
  const status = data[appName][5];

  if (plan === "premium" && status === "expired") {
    return res.json({ status: "error", message: "This VPS has expired and cannot be controlled" });
  }

  try {
    const out = await safeRun("docker", ["start", appName]);
    data[appName][4] = nowISO();
    data[appName][5] = "active";
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

app.post("/api/signup", (req, res) => {
  const { username, pass } = req.body;
  const ip = req.ip;

  if (!username || !pass) {
    return res.json({ status: "error", message: "Missing username or password" });
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return res.json({ status: "error", message: "Invalid username format" });
  }

  const creds = loadCredentials();

  if (creds.some(c => c.username === username)) {
    return res.json({ status: "error", message: "Username already exists" });
  }

  if (creds.some(c => c.ip === ip)) {
    return res.json({ status: "error", message: "Only one account per IP allowed" });
  }

  creds.push({ username, pass, servers: [], ip });
  saveCredentials(creds);
  res.json({ status: "success", message: "Account created" });
});

app.post("/api/login", (req, res) => {
  const { username, pass } = req.body;

  if (!username || !pass) {
    return res.json({ status: "error", message: "Missing username or password" });
  }

  const creds = loadCredentials();
  const user  = creds.find(c => c.username === username && c.pass === pass);

  res.json({ status: "success", valid: !!user });
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
      const [appPass, ipPort, logs, plan, lastStart, status, createdAt] = data[appName];
      apps[appName] = { appPass, ipPort, logs, plan, lastStart, status, createdAt };
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

  if (data[appName][0] !== appPassword) {
    return res.json({ status: "error", message: "Invalid app password" });
  }

  try {
    await purgeApp(appName);

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
    await purgeApp(appName);
    delete data[appName];
  }

  saveData(data);
  creds.splice(userIndex, 1);
  saveCredentials(creds);

  res.json({ status: "success", message: "Account and all associated apps have been permanently deleted" });
});

app.post("/api/change-credentials", (req, res) => {
  const { oldUsername, oldPassword, newUsername, newPassword } = req.body;

  if (!oldUsername || !oldPassword || !newUsername || !newPassword) {
    return res.json({ status: "error", message: "Missing required fields" });
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(newUsername)) {
    return res.json({ status: "error", message: "Invalid new username format" });
  }

  if (newPassword.length < 6) {
    return res.json({ status: "error", message: "New password must be at least 6 characters" });
  }

  const creds = loadCredentials();
  const userIndex = creds.findIndex(c => c.username === oldUsername && c.pass === oldPassword);

  if (userIndex === -1) {
    return res.json({ status: "error", message: "Invalid current credentials" });
  }

  if (newUsername !== oldUsername && creds.some(c => c.username === newUsername)) {
    return res.json({ status: "error", message: "New username is already taken" });
  }

  creds[userIndex].username = newUsername;
  creds[userIndex].pass     = newPassword;
  saveCredentials(creds);

  res.json({ status: "success", message: "Credentials updated successfully" });
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

  if (data[appName][0] !== oldAppPassword) {
    return res.json({ status: "error", message: "Invalid current app password" });
  }

  data[appName][0] = newAppPassword;
  saveData(data);

  res.json({ status: "success", message: "App password updated successfully" });
});

app.get(/.*/, (req, res) => {
  let file = req.path === "/" ? "index.html" : req.path.slice(1);

  if (!path.extname(file)) file += ".html";

  const filePath = path.join(PAGES_PATH, file);

  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send("Not Found");
  }
});

app.listen(3560, "0.0.0.0", () => console.log("Backend running on port 3560"));
