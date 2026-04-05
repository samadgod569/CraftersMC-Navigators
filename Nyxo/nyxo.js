#!/usr/bin/env node
// bin/nyxo.js

"use strict";

const readline = require("readline");
const chalk = require("chalk");
const { program } = require("commander");
const path = require("path");
const fs = require("fs");

const { printBanner, printMini, SEPARATOR } = require("../src/ascii");
const {
  getApiKey,
  getModelKey,
  getWorkerUrl,
  setApiKey,
  setModelKey,
  loadConfig,
  loadRecall,
  saveRecall,
  loadSkills,
  getRecallPath,
  CONFIG_DIR,
} = require("../src/config");
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
const { initMcp, getMcpStatus, disconnectAll } = require("../src/mcp");

// ─── CLI Commands ─────────────────────────────────────────────────────────────

program
  .name("nyxo")
  .description("Nyxo Code — AI Agent CLI powered by NyxoAI or your custom API")
  .version("1.1.0");

program
  .command("config")
  .description("Set API backend (NyxoAI or custom worker URL)")
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
  .command("recall")
  .description("Show or edit recall memory (~/.nyxo/recall.txt)")
  .option("--clear", "Clear all recall memory")
  .action((opts) => {
    if (opts.clear) {
      saveRecall("");
      ui.printSuccess("Recall memory cleared.");
      return;
    }
    const recall = loadRecall();
    console.log("\n" + chalk.bold.cyan("  ◉ Recall Memory") + chalk.gray(` (${getRecallPath()})`));
    console.log(chalk.gray("  " + "─".repeat(56)));
    if (recall) {
      recall.split("\n").forEach((line) => {
        if (!line.trim()) return;
        const [key, ...rest] = line.split("=");
        console.log(
          chalk.yellow(`  ${key}`) + chalk.gray("=") + chalk.white(rest.join("="))
        );
      });
    } else {
      console.log(chalk.gray("  (empty — AI will populate this as you share info)"));
    }
    console.log();
  });

program
  .command("run <message>")
  .description("Run a one-shot message and exit")
  .option("-k, --api-key <key>", "API key")
  .option("-m, --model <key>", "Model key")
  .option("-w, --worker <url>", "Custom worker URL")
  .action(async (message, opts) => {
    const workerUrl = opts.worker || getWorkerUrl();
    const apiKey    = opts.apiKey || getApiKey();
    const modelKey  = opts.model  || getModelKey();

    if (!workerUrl && (!apiKey || !modelKey)) {
      ui.printError("Missing credentials. Run: nyxo config");
      process.exit(1);
    }

    printMini();
    startSession(modelKey || "custom-worker");
    await runAgent(message, { apiKey, modelKey, workerUrl });
    process.exit(0);
  });

// ─── Default: Interactive REPL ────────────────────────────────────────────────

program
  .command("chat", { isDefault: true })
  .description("Start interactive agent session (default)")
  .option("-k, --api-key <key>", "API key override")
  .option("-m, --model <key>", "Model key override")
  .option("-w, --worker <url>", "Custom worker URL override")
  .option("--no-banner", "Skip banner")
  .action(async (opts) => {
    await startInteractive(opts);
  });

async function startInteractive(opts = {}) {
  if (opts.banner !== false) printBanner();

  // Auth — worker URL takes priority
  let workerUrl = opts.worker || getWorkerUrl();
  let apiKey    = opts.apiKey  || getApiKey();
  let modelKey  = opts.model   || getModelKey();

  if (!workerUrl && (!apiKey || !modelKey)) {
    ui.printInfo("No credentials found. Starting setup...\n");
    await runSetup(true);
    workerUrl = getWorkerUrl();
    apiKey    = getApiKey();
    modelKey  = getModelKey();
  }

  if (!workerUrl && (!apiKey || !modelKey)) {
    ui.printError("Could not get credentials. Exiting.");
    process.exit(1);
  }

  const sessionId = startSession(modelKey || "custom-worker");
  let firstMessage = null;

  // ── MCP servers ──────────────────────────────────────────────────────────────
  const mcpResult = await initMcp(ui);
  if (mcpResult.loaded && mcpResult.connected > 0) {
    console.log(chalk.gray(`  MCP:     ${mcpResult.connected}/${mcpResult.total} server(s) connected`));
  }

  // ── Status header ────────────────────────────────────────────────────────────
  console.log(chalk.gray(`  Session: ${sessionId}`));
  if (workerUrl) {
    console.log(chalk.magenta(`  API:     Custom Worker`));
    console.log(chalk.gray(`  URL:     ${workerUrl}`));
  } else {
    console.log(chalk.cyan(`  API:     NyxoAI`));
    console.log(chalk.cyan(`  Model:   ${modelKey}`));
  }
  console.log(chalk.gray(`  CWD:     ${process.cwd()}`));

  // Show recall/skills status
  const recall = loadRecall();
  const skills = loadSkills();
  if (recall) {
    const count = recall.split("\n").filter(Boolean).length;
    console.log(chalk.green(`  Recall:  ${count} entr${count === 1 ? "y" : "ies"} loaded`));
  }
  if (skills) {
    console.log(chalk.green(`  Skills:  skills.txt loaded (${skills.split("\n").length} lines)`));
  }

  console.log(SEPARATOR);
  console.log(chalk.gray("  Type your message. Use /help for commands."));
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
      const cmd   = parts[0].toLowerCase();

      switch (cmd) {
        case "/help":
          ui.printHelp();
          // Append extra commands
          console.log(chalk.gray("  /recall          Show current recall memory"));
          console.log(chalk.gray("  /recall clear    Clear all recall memory"));
          console.log(chalk.gray("  /skills          Show loaded skills.txt"));
          console.log(chalk.gray("  /api             Show current API mode"));
          break;

        case "/recall": {
          if (parts[1] === "clear") {
            saveRecall("");
            ui.printSuccess("Recall memory cleared.");
          } else {
            const mem = loadRecall();
            if (!mem) {
              ui.printInfo("Recall is empty. Share info with the AI and it will remember it.");
            } else {
              console.log("\n" + chalk.bold.cyan("  ◉ Recall Memory"));
              console.log(chalk.gray("  " + "─".repeat(48)));
              mem.split("\n").filter(Boolean).forEach((line) => {
                const [k, ...rest] = line.split("=");
                console.log(chalk.yellow(`  ${k}`) + chalk.gray("=") + chalk.white(rest.join("=")));
              });
              console.log();
            }
          }
          break;
        }

        case "/skills": {
          const sk = loadSkills();
          if (!sk) {
            ui.printInfo(
              "No skills.txt found. Create one in CWD or at ~/.nyxo/skills.txt"
            );
          } else {
            console.log("\n" + chalk.bold.cyan("  ◉ Active Skills"));
            console.log(chalk.gray("  " + "─".repeat(48)));
            sk.split("\n").forEach((l) => console.log(chalk.gray("  ") + chalk.white(l)));
            console.log();
          }
          break;
        }

        case "/api":
          if (workerUrl) {
            console.log("\n" + chalk.magenta("  ◉ API: Custom Worker"));
            console.log(chalk.gray(`  URL: ${workerUrl}`));
          } else {
            console.log("\n" + chalk.cyan("  ◉ API: NyxoAI"));
            console.log(chalk.gray(`  Model: ${modelKey}`));
          }
          console.log();
          break;

        case "/history":
          ui.printSessionHistory(loadPersistentHistory());
          break;

        case "/actions": {
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
        }

        case "/model":
          if (parts[1]) {
            modelKey = parts[1];
            setModelKey(modelKey);
            ui.printSuccess(`Model switched to: ${modelKey}`);
            logAction("model_switch", modelKey);
          } else {
            ui.printInfo(`Current model: ${modelKey || "(custom worker)"}`);
          }
          break;

        case "/clear":
          console.clear();
          printMini();
          break;

        case "/cwd":
          ui.printInfo(`Working directory: ${process.cwd()}`);
          break;

        case "/mcp": {
          const servers = getMcpStatus();
          if (!servers.length) {
            ui.printInfo("No MCP servers connected.");
          } else {
            console.log("\n" + chalk.bold.cyan("  ◉ MCP Servers"));
            console.log(chalk.gray("  " + "─".repeat(56)));
            servers.forEach((s) => {
              const status = s.connected ? chalk.green("◉ online") : chalk.red("✗ offline");
              console.log(`  ${status}  ${chalk.white(s.name)}  ${chalk.gray(`(${s.toolCount} tools: ${s.tools.join(", ")})`)}`);
            });
            console.log();
          }
          break;
        }

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
      await runAgent(input, { apiKey, modelKey, think: "LOW", temperature: 0.4, workerUrl });
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
  disconnectAll();
  saveSession(firstMessage || "Untitled session");
  console.log("\n" + chalk.cyan("  ◉ ") + chalk.gray("Session saved. Goodbye.\n"));
  process.exit(0);
}

// ─── Parse args ───────────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);
const knownCommands = ["config", "history", "clear-history", "run", "chat", "recall"];

const isKnown =
  rawArgs.length === 0 ||
  knownCommands.includes(rawArgs[0]) ||
  rawArgs[0]?.startsWith("-");

if (!isKnown && rawArgs.length > 0) {
  const msg = rawArgs.join(" ");
  (async () => {
    printMini();
    const workerUrl = getWorkerUrl();
    const apiKey    = getApiKey();
    const modelKey  = getModelKey();
    if (!workerUrl && (!apiKey || !modelKey)) {
      ui.printError("No credentials. Run: nyxo config");
      process.exit(1);
    }
    startSession(modelKey || "custom-worker");
    await runAgent(msg, { apiKey, modelKey, workerUrl });
    process.exit(0);
  })();
} else {
  program.parse(process.argv);
  if (process.argv.slice(2).length === 0) {
    startInteractive();
  }
}
