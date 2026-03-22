require("dotenv").config();
const express = require("express");
const fs = require("fs").promises;
const fsSync = require("fs");
const cors = require("cors");
const path = require("path");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const axios = require("axios");

const app = express();
const port = 3000;

app.use(express.json());
app.use(cors());

const DB_FILE = "./credentials.json";
const SERVE_FILE = "./serve.json";
const JWT_SECRET = "super_secret_jwt_signature_key_change_me";
const SALT_ROUNDS = 10;

// Security limiters
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: "Too many login attempts." } });
const createAccountLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: { error: "Too many accounts created." } });

// Initialization
if (!fsSync.existsSync(DB_FILE)) fsSync.writeFileSync(DB_FILE, JSON.stringify({ users: [] }, null, 2));
if (!fsSync.existsSync(SERVE_FILE)) fsSync.writeFileSync(SERVE_FILE, JSON.stringify(["index.html", "login.html", "signup.html", "404.html"], null, 2));

// Helpers
async function readDB() { return JSON.parse(await fs.readFile(DB_FILE, "utf-8")); }
async function writeDB(data) { await fs.writeFile(DB_FILE, JSON.stringify(data, null, 2)); }
function send404(res) {
  let file = path.join(__dirname, "404.html");
  fsSync.existsSync(file) ? res.status(404).sendFile(file) : res.status(404).send("404 Not Found");
}

/* --- SECURITY MIDDLEWARE --- */
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Access denied" });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Invalid token" });
    req.user = user;
    next();
  });
}

// --- API KEY HELPERS ---
const API_KEY_FILE = "api-key.json";

async function readApiKeys() {
  try {
    if (!fsSync.existsSync(API_KEY_FILE)) {
      await fs.writeFile(API_KEY_FILE, "{}");
      return {};
    }
    const data = await fs.readFile(API_KEY_FILE, "utf-8");
    if (!data) return {};
    return JSON.parse(data);
  } catch (err) {
    console.error("readApiKeys error:", err);
    return {};
  }
}

async function writeApiKeys(data) {
  try {
    await fs.writeFile(API_KEY_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("writeApiKeys error:", err);
    throw err;
  }
}

// --- CORE API ---

/* Create Account */
app.post("/end/create-account", createAccountLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "missing_fields" });
  if (username.length < 3 || username.length > 9) return res.status(400).json({ error: "username_length" });

  try {
    let db = await readDB();
    if (db.users.find(u => u.username === username)) return res.status(409).json({ error: "username_exists" });

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const newUser = {
      username,
      password: hashedPassword,
      rank: "member",
      tokens: 500,
      created_at: new Date().toISOString(),
      history: []
    };

    db.users.push(newUser);
    await writeDB(db);

    const token = jwt.sign({ username: newUser.username, rank: newUser.rank }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ success: true, token, rank: newUser.rank });
  } catch (error) {
    console.error("Signup Error:", error);
    res.status(500).json({ error: "server_error" });
  }
});

/* Login */
app.post("/end/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "missing_fields" });

  try {
    let db = await readDB();
    let user = db.users.find(u => u.username === username);
    if (!user) return res.status(401).json({ valid: false, error: "Invalid credentials" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ valid: false, error: "Invalid credentials" });

    const token = jwt.sign({ username: user.username, rank: user.rank }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ valid: true, token, tokens: user.tokens, rank: user.rank });
  } catch (error) {
    console.error("Login Error:", error);
    res.status(500).json({ valid: false, error: "server_error" });
  }
});

/* Live Data Refresh */
app.get("/end/me", authenticateToken, async (req, res) => {
  try {
    let db = await readDB();
    let user = db.users.find(u => u.username === req.user.username);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ username: user.username, rank: user.rank, tokens: user.tokens });
  } catch (error) {
    res.status(500).json({ error: "server_error" });
  }
});

/* Create API Key */
app.post("/end/create-api-key", async (req, res) => {
  const { username, password, name } = req.body;
  if (!username || !password || !name) return res.status(400).json({ error: "missing_fields" });

  try {
    const db = await readDB();
    const user = db.users.find(u => u.username === username);
    if (!user) return res.status(401).json({ error: "invalid_credentials" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "invalid_credentials" });

    const apiKey = "nyxo_" + crypto.randomBytes(16).toString("hex");
    const keys = await readApiKeys();
    if (!keys[username]) keys[username] = {};
    keys[username][name] = apiKey;

    await writeApiKeys(keys);
    res.json({ success: true, name, apiKey });
  } catch (err) {
    console.error("Create API Key Error:", err);
    res.status(500).json({ error: "server_error" });
  }
});

/* Get API Keys */
app.post("/end/get-api", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "missing_fields" });

  try {
    const db = await readDB();
    const user = db.users.find(u => u.username === username);
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });

    const keys = await readApiKeys();
    res.json({ apiKeys: keys[username] || {} });
  } catch (err) {
    console.error("Get API Keys Error:", err);
    res.status(500).json({ error: "server_error" });
  }
});

/* Get Profile */
app.post("/end/get-profile", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "missing_fields" });

  try {
    let db = await readDB();
    let user = db.users.find(u => u.username === username);
    if (!user) return res.status(401).json({ error: "invalid_credentials" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ error: "invalid_credentials" });

    const { password: pwd, ...userData } = user;
    res.json(userData);
  } catch (error) {
    console.error("Get Profile Error:", error);
    res.status(500).json({ error: "server_error" });
  }
});

/* Change Profile */
app.post("/api/change-profile", async (req, res) => {
  const { oldUsername, oldPassword, newUsername, newPassword } = req.body;
  if (!oldUsername || !oldPassword || !newUsername || !newPassword)
    return res.status(400).json({ error: "missing_fields" });

  try {
    const db = await readDB();
    const user = db.users.find(u => u.username === oldUsername);
    if (!user) return res.status(401).json({ error: "invalid_credentials" });

    const match = await bcrypt.compare(oldPassword, user.password);
    if (!match) return res.status(401).json({ error: "invalid_credentials" });

    if (oldUsername !== newUsername) {
      const exists = db.users.find(u => u.username === newUsername);
      if (exists) return res.status(409).json({ error: "name_already_exists" });
    }

    const newHashedPassword = await bcrypt.hash(newPassword, SALT_ROUNDS);
    user.username = newUsername;
    user.password = newHashedPassword;

    await writeDB(db);
    res.json({ success: true, message: "Credentials Saved Successfully" });
  } catch (err) {
    console.error("Change Profile Error:", err);
    res.status(500).json({ error: "server_error" });
  }
});

/* Assistant (OpenRouter) */
app.post("/api/assistant", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "missing_message" });

  const OPENROUTER_API_KEY = "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";

  try {
    const trainingPrompt = await fs.readFile("./training/assistant.txt", "utf-8");

    const requestBody = {
      model: "openrouter/free",
      messages: [
        { role: "system", content: trainingPrompt },
        { role: "user", content: message }
      ],
      max_tokens: 64000
    };

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });

    const data = await response.json();
    res.json({ reply: data.choices?.[0]?.message?.content || "No response" });
  } catch (err) {
    console.error("Assistant API Error:", err);
    res.status(500).json({ error: "assistant_failed" });
  }
});

/* Get Model Data */
const MODELS_FILE = "./models.json";

app.get("/end/get-model-data", async (req, res) => {
  try {
    if (!fsSync.existsSync(MODELS_FILE)) {
      return res.status(404).json({ error: "models_file_not_found" });
    }
    const data = await fs.readFile(MODELS_FILE, "utf-8");
    const models = JSON.parse(data);
    res.json(models);
  } catch (err) {
    console.error("Get Models Error:", err);
    res.status(500).json({ error: "server_error" });
  }
});


app.post("/end/delete-api-key", async (req, res) => {
  const { username, password, name } = req.body;

  if (!username || !password || !name) {
    return res.status(400).json({ error: "missing_fields" });
  }

  try {
    const db = await readDB();
    const user = db.users.find(u => u.username === username);

    if (!user) {
      return res.status(401).json({ error: "invalid_credentials" });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ error: "invalid_credentials" });
    }

    const keys = await readApiKeys();

    if (!keys[username] || !keys[username][name]) {
      return res.status(404).json({ error: "api_key_not_found" });
    }

    delete keys[username][name];

    // if user has no more keys remove empty object
    if (Object.keys(keys[username]).length === 0) {
      delete keys[username];
    }

    await writeApiKeys(keys);

    res.json({
      success: true,
      message: "API key deleted successfully"
    });

  } catch (err) {
    console.error("Delete API Key Error:", err);
    res.status(500).json({ error: "server_error" });
  }
});

app.post("/end/delete-account", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "missing_fields" });
  }

  try {
    const db = await readDB();
    const userIndex = db.users.findIndex(u => u.username === username);

    if (userIndex === -1) {
      return res.status(401).json({ error: "invalid_credentials" });
    }

    const user = db.users[userIndex];

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ error: "invalid_credentials" });
    }

    // remove user
    db.users.splice(userIndex, 1);
    await writeDB(db);

    // remove their API keys
    const keys = await readApiKeys();
    if (keys[username]) {
      delete keys[username];
      await writeApiKeys(keys);
    }

    res.json({
      success: true,
      message: "Account deleted successfully"
    });

  } catch (err) {
    console.error("Delete Account Error:", err);
    res.status(500).json({ error: "server_error" });
  }
});
app.post("/api/v1/assistant", async (req, res) => {
  let {
    username,
    apiKey,
    message,
    memory = "",
    skills = "",
    think = "LOW",
    crawling = [],
    compare = null,
    modelKey,
    temperature = 0.5
  } = req.body || {};

  if (!username || !apiKey || !message || !modelKey)
    return res.status(400).json({ error: "nyxoAI_missing_fields" });

  try {
    // ✅ Read user DB
    const db = await readDB();
    const user = db.users.find(u => u.username === username);
    if (!user) return res.status(401).json({ error: "nyxoAI_invalid_user" });

    // ✅ Validate API key
    const apiKeys = await readApiKeys();
    if (!apiKeys[username] || !Object.values(apiKeys[username]).includes(apiKey))
      return res.status(403).json({ error: "nyxoAI_invalid_api_key" });

    if (!Array.isArray(crawling)) crawling = [];

    // ✅ Limits for text
    const LIMITS = {
      message: 20000000000000000,
      memory: 20000000000000,
      skills: 20000000000000,
      crawl: 200000000000
    };

    message = message.slice(0, LIMITS.message);
    memory = memory.slice(0, LIMITS.memory);
    skills = skills.slice(0, LIMITS.skills);

    const countTokens = (str) =>
      str ? Buffer.byteLength(String(str), "utf-8") : 0;

    let usedTokens =
      countTokens(message) + countTokens(memory) + countTokens(skills);

    // ✅ Crawl external URLs
    let crawlText = "";
    for (let url of crawling) {
      try {
        const resp = await axios.get(url, { timeout: 8000 });
        let text =
          typeof resp.data === "string"
            ? resp.data
            : JSON.stringify(resp.data);
        text = text.slice(0, LIMITS.crawl);
        crawlText += text;
        usedTokens += countTokens(text);
      } catch {
        continue;
      }
    }

    // ✅ FIX: max_new_tokens = output budget, NOT reduced by input size.
    //    usedTokens is only used to check the user has enough balance overall.
    //    Subtracting it from max_new_tokens was wrongly shrinking the output window.
    let max_new_tokens = user.tokens;
    if (max_new_tokens > 128000) max_new_tokens = 128000;
    max_new_tokens = max_new_tokens - 18;

    if (max_new_tokens - usedTokens <= 0)
      return res.status(400).json({ error: "nyxoAI_not_enough_tokens" });

    // ✅ Build final prompt
    let finalPrompt = "";
    if (memory) finalPrompt += `THIS IS YOUR MEMORY:\n${memory}\n\n`;
    if (skills) finalPrompt += `THIS IS YOUR SKILLS:\n${skills}\n\n`;
    finalPrompt += `THINK ${think}\n\n`;
    if (crawlText) finalPrompt += `CRAWLED DATA:\n${crawlText}\n\n`;
    finalPrompt += `USER MESSAGE:\n${message}`;

    const models = JSON.parse(await fs.readFile("./models.json", "utf-8"));
    const mainModel = models[modelKey];
    if (!mainModel)
      return res.status(400).json({ error: "nyxoAI_invalid_model" });

    // ✅ FIX: Full extractTokens matching the first endpoint.
    //    The second version was missing `response?.provider?.usage?.total_tokens`
    //    as an explicit fallback, causing many provider formats to return 0.
    function extractTokens(response) {
      const usage =
        response?.provider?.usage ||
        response?.usage ||
        response?.data?.usage ||
        {};

      const geminiUsage =
        response?.provider?.usageMetadata ||
        response?.usageMetadata ||
        {};

      const providerTotal =
        usage.total_tokens ||
        usage.totalTokens ||
        response?.provider?.usage?.total_tokens || // <-- was missing in v2
        0;

      const openaiStyle =
        (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);

      const anthropicStyle =
        (usage.input_tokens || 0) + (usage.output_tokens || 0);

      const camelCaseStyle =
        (usage.promptTokens || 0) + (usage.completionTokens || 0);

      const geminiStyle =
        geminiUsage.totalTokenCount ||
        (geminiUsage.promptTokenCount || 0) +
        (geminiUsage.candidatesTokenCount || 0);

      return (
        providerTotal ||
        geminiStyle ||
        openaiStyle ||
        anthropicStyle ||
        camelCaseStyle ||
        0
      );
    }

    // ✅ Call Bytez model
    const callModel = async (model, payload, tokenLimit) => {
      const keys = (process.env.BYTEZ_KEYS || "").split(",").filter(Boolean);
      if (!keys.length) throw new Error("No BYTEZ_KEYS found");
      if (tokenLimit <= 0) throw new Error("User token balance exhausted");

      let lastError = null;
      for (const key of keys) {
        try {
          const response = await axios.post(
            `https://api.bytez.com/models/v2/${model.key}`,
            { ...payload, stream: false, max_new_tokens: tokenLimit },
            {
              headers: {
                Authorization: key,
                "Content-Type": "application/json"
              },
              timeout: 30000
            }
          );
          return response.data;
        } catch (err) {
          console.error("Bytez API Error:", err.response?.data || err.message);
          lastError = err;
        }
      }
      throw lastError || new Error("All Bytez API keys failed");
    };

    // ✅ Call main model
    const mainResponse = await callModel(
      mainModel,
      { messages: [{ role: "user", content: finalPrompt }], temperature },
      max_new_tokens
    );

    if (!mainResponse) throw new Error("Model returned empty response");

    const mainTokens = extractTokens(mainResponse);

    let remainingTokens = user.tokens - mainTokens;
    if (remainingTokens < 0) remainingTokens = 0;
    user.tokens = remainingTokens;

    let result = {};
    result[modelKey] = mainResponse;

    // ✅ Compare model (optional)
    if (compare) {
      const compareModel = models[compare];
      if (!compareModel)
        return res.status(400).json({ error: "nyxoAI_invalid_compare_model" });

      const compareResponse = await callModel(
        compareModel,
        { messages: [{ role: "user", content: finalPrompt }], temperature },
        remainingTokens - 18
      );
      const compareTokens = extractTokens(compareResponse);

      remainingTokens -= compareTokens;
      if (remainingTokens < 0) remainingTokens = 0;
      user.tokens = remainingTokens;

      result[compare] = compareResponse;
    }

    // ✅ Extract readable output text
    let outputText = "";
    if (mainResponse?.choices?.[0]?.message?.content)
      outputText = mainResponse.choices[0].message.content;
    else if (mainResponse?.choices?.[0]?.text)
      outputText = mainResponse.choices[0].text;
    else if (mainResponse?.output?.[0]?.content?.[0]?.text)
      outputText = mainResponse.output[0].content[0].text;
    else if (mainResponse?.output?.[0]?.embedding)
      outputText = JSON.stringify(mainResponse.output[0].embedding);
    else
      outputText = JSON.stringify(mainResponse);

    // ✅ Save history
    const date = new Date().toISOString().split("T")[0];
    if (!user.history) user.history = [];
    user.history.unshift({ model: modelKey, token: String(mainTokens), date });
    if (user.history.length > 30) user.history.pop();

    // ✅ FIX: Track mainModel.usage (was missing in v2 entirely)
    if (!Array.isArray(mainModel.usage)) mainModel.usage = [];

    let foundMain = false;
    mainModel.usage = mainModel.usage.map(entry => {
      if (entry.startsWith(date + "[*]")) {
        foundMain = true;
        let parts = entry.split("[*]");
        let count = parseInt(parts[1]) || 0;
        return `${date}[*]${count + 1}`;
      }
      return entry;
    });

    if (!foundMain) mainModel.usage.unshift(`${date}[*]1`);
    if (mainModel.usage.length > 30) mainModel.usage.pop();

    await writeDB(db);
    await fs.writeFile("./models.json", JSON.stringify(models, null, 2)); // was missing in v2

    res.json(result);

  } catch (err) {
    console.error("NyxoAI ERROR:", err);
    if (err.response) {
      return res.status(err.response.status || 500).json({
        message: err.message,
        providerError: err.response.data
      });
    }
    return res.status(500).json({ message: err.message, stack: err.stack });
  }
});
      
// --- ROUTING ---
app.get("/img/:filename", (req, res) => {
  if (req.headers["sec-fetch-dest"] === "document" || !req.headers["referer"]) return send404(res);
  let file = path.join(__dirname, "img", req.params.filename);
  fsSync.existsSync(file) ? res.sendFile(file) : send404(res);
});

app.get("/", async (req, res) => {
  let allowed = JSON.parse(await fs.readFile(SERVE_FILE, "utf-8"));
  allowed.includes("index.html") ? res.sendFile(path.join(__dirname, "index.html")) : send404(res);
});

app.get("/:page", async (req, res) => {
  let page = req.params.page.endsWith(".html") ? req.params.page : req.params.page + ".html";
  let allowed = JSON.parse(await fs.readFile(SERVE_FILE, "utf-8"));
  if (!allowed.includes(page)) return send404(res);
  let file = path.join(__dirname, page);
  fsSync.existsSync(file) ? res.sendFile(file) : send404(res);
});

app.use((req, res) => send404(res));
app.listen(port, () => console.log(`Secure server running on port ${port}`));
