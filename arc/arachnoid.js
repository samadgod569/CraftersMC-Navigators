const express = require("express");
const fs = require("fs");
const { execFile } = require("child_process");
const path = require("path");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

const BASE_PATH = "/platform/apps";
const DATA_PATH = "/platform/data/ports.json";
const PAGES_PATH = "/platform/pages";
const VPS_IP = "45.137.70.54";

function safeRun(cmd, args = []) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 20000 }, (err, stdout, stderr) => {
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

const IMAGES = {
  nodejs: "node:18",
  python: "python:3.12",
  go: "golang:1.21",
  ts: "node:18",
};

app.post("/api/deploy", async (req, res) => {
  const { appName, repo, zipUrl, language, packages, startFile, password } = req.body;
  let logs = [];

  if (!appName || (!repo && !zipUrl) || !language || !startFile || !password) {
    return res.json({ status: "error", message: "Missing required fields", logs });
  }

  if (!isValidName(appName)) {
    return res.json({ status: "error", message: "Invalid app name" });
  }

  if (repo && !isValidRepo(repo)) {
    return res.json({ status: "error", message: "Only GitHub repos allowed" });
  }

  if (zipUrl && !isValidUrl(zipUrl)) {
    return res.json({ status: "error", message: "Invalid zip URL" });
  }

  const appPath = path.join(BASE_PATH, appName);
  let data = loadData();

  if (data[appName] && data[appName][0] !== password) {
    return res.json({ status: "error", message: "Invalid password", logs });
  }

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

    let dockerfile = `FROM ${IMAGES[language]}
WORKDIR /app
COPY . .

RUN useradd -m appuser
USER appuser
`;

    if (language === "nodejs" || language === "ts") {
      packages?.forEach(pkg => dockerfile += `RUN npm install ${pkg}\n`);
      if (language === "ts") dockerfile += `RUN npm install -g ts-node typescript\n`;
    } else if (language === "python") {
      packages?.forEach(pkg => dockerfile += `RUN pip install ${pkg}\n`);
    } else if (language === "go") {
      packages?.forEach(pkg => dockerfile += `RUN go install ${pkg}@latest\n`);
    }

    if (language === "nodejs") dockerfile += `CMD ["node","${startFile}"]\n`;
    else if (language === "ts") dockerfile += `CMD ["npx","ts-node","${startFile}"]\n`;
    else if (language === "python") dockerfile += `CMD ["python3","${startFile}"]\n`;
    else if (language === "go") dockerfile += `CMD ["go","run","${startFile}"]\n`;

    fs.writeFileSync(path.join(appPath, "Dockerfile"), dockerfile);
    logs.push("Dockerfile created.");

    logs.push(await safeRun("docker", ["build", "-t", appName, appPath]));
    logs.push("Docker image built.");

    const PORT_BASE = 4000;
    let usedPorts = Object.values(data).map(v => v[1]);
    let port = data[appName]?.[1] || PORT_BASE;
    while (usedPorts.includes(port) && port !== data[appName]?.[1]) port++;

    logs.push(await safeRun("docker", [
      "run",
      "-d",
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

    data[appName] = [password, port, logs];
    saveData(data);

    res.json({
      status: "success",
      app: {
        name: appName,
        port,
        url: `http://${VPS_IP}:${port}`
      },
      logs
    });

  } catch (err) {
    logs.push(err.toString());
    data[appName] = [password, data[appName]?.[1] || null, logs];
    saveData(data);

    res.json({
      status: "error",
      message: "Deployment failed",
      logs
    });
  }
});

app.post("/api/stop", async (req, res) => {
  const { appName, password } = req.body;
  let data = loadData();

  const v = validate(appName, password, data);
  if (!v.ok) return res.json({ status: "error", message: v.msg });

  try {
    const out = await safeRun("docker", ["stop", appName]);
    res.json({ status: "success", output: out });
  } catch (e) {
    res.json({ status: "error", message: e.toString() });
  }
});

app.post("/api/start", async (req, res) => {
  const { appName, password } = req.body;
  let data = loadData();

  const v = validate(appName, password, data);
  if (!v.ok) return res.json({ status: "error", message: v.msg });

  try {
    const out = await safeRun("docker", ["start", appName]);
    res.json({ status: "success", output: out });
  } catch (e) {
    res.json({ status: "error", message: e.toString() });
  }
});

app.post("/api/inspect", async (req, res) => {
  const { appName, password } = req.body;
  let data = loadData();

  const v = validate(appName, password, data);
  if (!v.ok) return res.json({ status: "error", message: v.msg });

  try {
    let out = await safeRun("docker", ["inspect", appName]);
    let json = JSON.parse(out);

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
  let data = loadData();

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
  const CRED_PATH = "/platform/data/credentials.json";

  function loadCredentials() {
    if (!fs.existsSync(CRED_PATH)) return [];
    return JSON.parse(fs.readFileSync(CRED_PATH, "utf-8"));
  }

  function saveCredentials(data) {
    fs.writeFileSync(CRED_PATH, JSON.stringify(data, null, 2));
  }

  const { username, pass } = req.body;
  const ip = req.ip || req.connection.remoteAddress;

  if (!username || !pass) {
    return res.json({ status: "error", message: "Missing username or password" });
  }

  let creds = loadCredentials();

  if (creds.some(c => c.username === username)) {
    return res.json({ status: "error", message: "Username already exists" });
  }

  if (creds.some(c => c.ip === ip)) {
    return res.json({ status: "error", message: "Only one account per IP allowed" });
  }

  creds.push({
    username,
    pass,
    servers: [],
    ip
  });

  saveCredentials(creds);
  res.json({ status: "success", message: "Account created" });
});

app.post("/api/login", (req, res) => {
  const CRED_PATH = "/platform/data/credentials.json";

  function loadCredentials() {
    if (!fs.existsSync(CRED_PATH)) return [];
    return JSON.parse(fs.readFileSync(CRED_PATH, "utf-8"));
  }

  const { username, pass } = req.body;

  if (!username || !pass) {
    return res.json({ status: "error", message: "Missing username or password" });
  }

  const creds = loadCredentials();
  const user = creds.find(c => c.username === username && c.pass === pass);

  if (user) {
    res.json({ status: "success", valid: true });
  } else {
    res.json({ status: "success", valid: false });
  }
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
