// src/setup.js
const inquirer = require("inquirer");
const chalk = require("chalk");
const {
  setApiKey,
  setModelKey,
  setWorkerUrl,
  loadConfig,
  getConfigPath,
} = require("./config");
const ui = require("./ui");

async function runSetup(force = false) {
  const cfg = loadConfig();

  if (!force && (cfg.workerUrl || (cfg.apiKey && cfg.modelKey))) {
    return true; // Already configured
  }

  console.log("\n" + chalk.bold.cyan("  ◉ Nyxo Code Setup"));
  console.log(chalk.gray("  Choose your AI backend\n"));

  // ── Step 1: Choose API mode ──────────────────────────────────────────────────
  const { apiMode } = await inquirer.prompt([
    {
      type: "list",
      name: "apiMode",
      message: chalk.cyan("  Which API do you want to use?"),
      choices: [
        {
          name: "NyxoAI  (official — enter API key + model)",
          value: "nyxo",
        },
        {
          name: "Custom Worker  (your own endpoint — no API key needed here)",
          value: "custom",
        },
      ],
      default: cfg.workerUrl ? "custom" : "nyxo",
    },
  ]);

  if (apiMode === "custom") {
    // ── Custom worker setup ────────────────────────────────────────────────────
    const { workerUrl } = await inquirer.prompt([
      {
        type: "input",
        name: "workerUrl",
        message: chalk.cyan("  Worker URL (e.g. https://my-worker.example.com/ai):"),
        default: cfg.workerUrl || "",
        validate: (v) => {
          if (!v.trim()) return "Worker URL is required";
          try {
            new URL(v.trim());
            return true;
          } catch {
            return "Please enter a valid URL";
          }
        },
      },
    ]);

    setWorkerUrl(workerUrl.trim());
    // Clear NyxoAI credentials if switching away
    if (cfg.apiKey || cfg.modelKey) {
      const { keepNyxo } = await inquirer.prompt([
        {
          type: "confirm",
          name: "keepNyxo",
          message: chalk.cyan("  Keep existing NyxoAI credentials as fallback?"),
          default: true,
        },
      ]);
      if (!keepNyxo) {
        setApiKey("");
        setModelKey("");
      }
    }

    ui.printSuccess(`Custom worker saved: ${workerUrl.trim()}`);
    console.log(chalk.gray("  Questions will be sent as: GET <url>?question=..."));

  } else {
    // ── NyxoAI setup ──────────────────────────────────────────────────────────
    const answers = await inquirer.prompt([
      {
        type: "password",
        name: "apiKey",
        message: chalk.cyan("  NyxoAI API Key:"),
        default: cfg.apiKey || "",
        mask: "●",
        validate: (v) => v.trim().length > 0 || "API key is required",
      },
      {
        type: "input",
        name: "modelKey",
        message: chalk.cyan("  Model Key (e.g. mistralai/Mistral-7B-Instruct-v0.2):"),
        default: cfg.modelKey || "",
        validate: (v) => v.trim().length > 0 || "Model key is required",
      },
    ]);

    setApiKey(answers.apiKey.trim());
    setModelKey(answers.modelKey.trim());
    // Clear worker URL if switching to NyxoAI
    setWorkerUrl("");

    ui.printSuccess(`NyxoAI config saved to ${getConfigPath()}`);
  }

  console.log();
  return true;
}

module.exports = { runSetup };
