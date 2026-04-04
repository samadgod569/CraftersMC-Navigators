// src/setup.js
const inquirer = require("inquirer");
const chalk = require("chalk");
const { setApiKey, setModelKey, loadConfig, getConfigPath } = require("./config");
const ui = require("./ui");

async function runSetup(force = false) {
  const cfg = loadConfig();

  if (!force && cfg.apiKey && cfg.modelKey) {
    return true; // Already configured
  }

  console.log("\n" + chalk.bold.cyan("  ◉ Nyxo Code Setup"));
  console.log(chalk.gray("  Configure your NyxoAI credentials\n"));

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

  ui.printSuccess(`Config saved to ${getConfigPath()}`);
  console.log();

  return true;
}

module.exports = { runSetup };
