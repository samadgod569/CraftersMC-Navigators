#!/usr/bin/env node
// bin/nyxo.js

"use strict";

const readline = require("readline");
const chalk = require("chalk");
const { program } = require("commander");
const path = require("path");
const fs = require("fs");

const { printBanner, printMini, SEPARATOR } = require("../src/ascii");
const { getApiKey, getModelKey, setApiKey, setModelKey, loadConfig } = require("../src/config");
const { runAgent } = require("../src/agent");
const {
  startSession,
  saveSession,
  loadPersistentHistory,
  clearHistory,
  getActionLog,
  logAction,
} = require("../src/history");
const ui = require("../src/ui");
const { runSetup } = require("../src/setup");

// ─── CLI Commands ─────────────────────────────────────────────────────────────

program
  .name("nyxo")
  .description("Nyxo Code — AI Agent CLI powered by NyxoAI")
  .version("1.0.0");

program
  .command("config")
  .description("Set API key and model key")
  .action(async () => {
    await runSetup(true);
  });

program
  .command("history")
  .description("Show past sessions")
  .action(() => {
    const sessions = loadPersistentHistory();
    ui.printSessionHistory(sessions);
  });

program
  .command("clear-history")
  .description("Clear all session history")
  .action(() => {
    clearHistory();
    ui.printSuccess("History cleared.");
  });

program
  .command("run <message>")
  .description("Run a one-shot message and exit")
  .option("-k, --api-key <key>", "API key")
  .option("-m, --model <key>", "Model key")
  .action(async (message, opts) => {
    const apiKey = opts.apiKey || getApiKey();
    const modelKey = opts.model || getModelKey();
    if (!apiKey || !modelKey) {
      ui.printError("Missing API key or model key. Run: nyxo config");
      process.exit(1);
    }
    printMini();
    startSession(modelKey);
    await runAgent(message, { apiKey, modelKey });
    process.exit(0);
  });

// ─── Default: Interactive REPL ────────────────────────────────────────────────

program
  .command("chat", { isDefault: true })
  .description("Start interactive agent session (default)")
  .option("-k, --api-key <key>", "API key override")
  .option("-m, --model <key>", "Model key override")
  .option("--no-banner", "Skip banner")
  .action(async (opts) => {
    await startInteractive(opts);
  });

async function startInteractive(opts = {}) {
  // Print banner
  if (opts.banner !== false) printBanner();

  // Auth
  let apiKey = opts.apiKey || getApiKey();
  let modelKey = opts.model || getModelKey();

  if (!apiKey || !modelKey) {
    ui.printInfo("No credentials found. Starting setup...\n");
    await runSetup(true);
    apiKey = getApiKey();
    modelKey = getModelKey();
  }

  if (!apiKey || !modelKey) {
    ui.printError("Could not get credentials. Exiting.");
    process.exit(1);
  }

  // Session
  const sessionId = startSession(modelKey);
  let firstMessage = null;

  console.log(chalk.gray(`  Session: ${sessionId}`));
  console.log(chalk.cyan(`  Model:   ${modelKey}`));
  console.log(chalk.gray(`  CWD:     ${process.cwd()}`));
  console.log(SEPARATOR);
  console.log(chalk.gray('  Type your message. Use /help for commands.'));
  console.log();

  // ─── Readline REPL ──────────────────────────────────────────────────────────

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: ui.getPrompt(),
    historySize: 100,
    terminal: true,
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // ─── Slash Commands ───────────────────────────────────────────────────────

    if (input.startsWith("/")) {
      const parts = input.split(" ");
      const cmd = parts[0].toLowerCase();

      switch (cmd) {
        case "/help":
          ui.printHelp();
          break;

        case "/history":
          ui.printSessionHistory(loadPersistentHistory());
          break;

        case "/actions":
          const log = getActionLog();
          if (!log.length) {
            ui.printInfo("No actions yet this session.");
          } else {
            console.log("\n" + chalk.bold.cyan("  ◉ Action Log — This Session"));
            console.log(chalk.gray("  " + "─".repeat(56)));
            log.forEach((a, i) => {
              const ts = new Date(a.ts).toLocaleTimeString();
              console.log(
                chalk.gray(`  ${String(i + 1).padStart(2)}.`) +
                chalk.yellow(` [${a.type}]`) +
                chalk.gray(` ${ts}`) +
                "\n" +
                chalk.gray("      ") + chalk.white(a.detail)
              );
            });
            console.log();
          }
          break;

        case "/model":
          if (parts[1]) {
            modelKey = parts[1];
            setModelKey(modelKey);
            ui.printSuccess(`Model switched to: ${modelKey}`);
            logAction("model_switch", modelKey);
          } else {
            ui.printInfo(`Current model: ${modelKey}`);
          }
          break;

        case "/clear":
          console.clear();
          printMini();
          break;

        case "/cwd":
          ui.printInfo(`Working directory: ${process.cwd()}`);
          break;

        case "/exit":
        case "/quit":
          await handleExit(rl, firstMessage);
          return;

        default:
          ui.printWarning(`Unknown command: ${cmd}. Type /help for commands.`);
      }

      rl.prompt();
      return;
    }

    // ─── Agent Message ────────────────────────────────────────────────────────

    if (!firstMessage) firstMessage = input;

    rl.pause();

    try {
      await runAgent(input, { apiKey, modelKey, think: "LOW", temperature: 0.4 });
    } catch (err) {
      ui.printError(err.message || "Unknown error");
    }

    console.log();
    rl.resume();
    rl.prompt();
  });

  rl.on("close", async () => {
    await handleExit(null, firstMessage);
  });

  process.on("SIGINT", async () => {
    console.log();
    await handleExit(rl, firstMessage);
  });
}

async function handleExit(rl, firstMessage) {
  if (rl) rl.close();
  saveSession(firstMessage || "Untitled session");
  console.log("\n" + chalk.cyan("  ◉ ") + chalk.gray("Session saved. Goodbye.\n"));
  process.exit(0);
}

// ─── Parse args ───────────────────────────────────────────────────────────────

// If called with no subcommand and args, treat as inline message
const rawArgs = process.argv.slice(2);
const knownCommands = ["config", "history", "clear-history", "run", "chat"];

const isKnown = rawArgs.length === 0 || knownCommands.includes(rawArgs[0]) || rawArgs[0]?.startsWith("-");

if (!isKnown && rawArgs.length > 0) {
  // `nyxo "do something"` shorthand
  const msg = rawArgs.join(" ");
  (async () => {
    printMini();
    const apiKey = getApiKey();
    const modelKey = getModelKey();
    if (!apiKey || !modelKey) {
      ui.printError("No credentials. Run: nyxo config");
      process.exit(1);
    }
    startSession(modelKey);
    await runAgent(msg, { apiKey, modelKey });
    process.exit(0);
  })();
} else {
  program.parse(process.argv);

}
