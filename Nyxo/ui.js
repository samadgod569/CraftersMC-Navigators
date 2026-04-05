// src/ui.js
const chalk = require("chalk");
const ora = require("ora");
const { SEPARATOR } = require("./ascii");

// ─── Spinner ──────────────────────────────────────────────────────────────────

let _spinner = null;

function startSpinner(text = "Thinking…") {
  _spinner = ora({
    text: chalk.cyan(text),
    spinner: "dots12",
    color: "cyan",
  }).start();
  return _spinner;
}

function updateSpinner(text) {
  if (_spinner) _spinner.text = chalk.cyan(text);
}

function stopSpinner(success = true, text = "") {
  if (!_spinner) return;
  if (success) {
    _spinner.succeed(chalk.cyan(text || "Done"));
  } else {
    _spinner.fail(chalk.red(text || "Failed"));
  }
  _spinner = null;
}

function clearSpinner() {
  if (_spinner) { _spinner.stop(); _spinner = null; }
}

// ─── Output Formatters ────────────────────────────────────────────────────────

function printUser(msg) {
  console.log("\n" + chalk.bold.white("┌─ You ") + chalk.gray("─".repeat(52)));
  console.log(chalk.white("│ ") + chalk.white(msg.split("\n").join("\n│ ")));
  console.log(chalk.gray("└" + "─".repeat(58)));
}

function printAssistant(msg) {
  const lines = msg.split("\n");
  console.log("\n" + chalk.bold.cyan("┌─ Nyxo ◉ ") + chalk.gray("─".repeat(48)));

  lines.forEach((line) => {
    // Syntax highlight code blocks visually
    if (line.startsWith("```")) {
      console.log(chalk.gray("│ ") + chalk.yellow(line));
    } else if (line.startsWith("#")) {
      console.log(chalk.gray("│ ") + chalk.bold.cyan(line));
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      console.log(chalk.gray("│ ") + chalk.cyan("  •") + chalk.white(" " + line.slice(2)));
    } else if (/^\d+\./.test(line)) {
      console.log(chalk.gray("│ ") + chalk.cyan("  " + line));
    } else {
      console.log(chalk.gray("│ ") + chalk.white(line));
    }
  });

  console.log(chalk.cyan("└" + "─".repeat(58)));
}

function printToolCall(toolName, args) {
  const argStr = Object.entries(args)
    .map(([k, v]) => `${k}=${String(v).slice(0, 50)}`)
    .join(", ");
  console.log(
    "\n" +
    chalk.bold.yellow("  ⚡ Tool: ") +
    chalk.yellow(toolName) +
    chalk.gray(` (${argStr})`)
  );
}

function printToolResult(toolName, result) {
  const preview = result.slice(0, 200).replace(/\n/g, " ↵ ");
  const status = result.startsWith("Error") ? chalk.red("✗") : chalk.green("✓");
  console.log(
    chalk.gray("  └─ ") +
    status +
    " " +
    chalk.gray(preview) +
    (result.length > 200 ? chalk.gray(" [...]") : "")
  );
}

function printError(msg) {
  console.log("\n" + chalk.bold.red("  ✗ Error: ") + chalk.red(msg));
}

function printInfo(msg) {
  console.log(chalk.cyan("  ℹ ") + chalk.gray(msg));
}

function printSuccess(msg) {
  console.log(chalk.green("  ✓ ") + chalk.green(msg));
}

function printWarning(msg) {
  console.log(chalk.yellow("  ⚠ ") + chalk.yellow(msg));
}

function printSep() {
  console.log(chalk.gray("─".repeat(60)));
}

function printSessionHistory(sessions) {
  if (!sessions.length) {
    printInfo("No session history found.");
    return;
  }
  console.log("\n" + chalk.bold.cyan("  ◉ Session History"));
  console.log(chalk.gray("  " + "─".repeat(56)));
  sessions.slice(0, 15).forEach((s, i) => {
    const date = new Date(s.date).toLocaleString();
    console.log(
      chalk.gray(`  ${String(i + 1).padStart(2)}.`) +
      chalk.white(` "${s.title}"`) +
      chalk.gray(` · ${date}`)
    );
    console.log(
      chalk.gray(`       ${s.turns} turns · ${s.actions} actions`)
    );
  });
  console.log();
}

function printHelp() {
  console.log(`
${chalk.bold.cyan("  Nyxo Code — Commands")}
${chalk.gray("  ─────────────────────────────────────────────")}
  ${chalk.cyan("/help")}         Show this help
  ${chalk.cyan("/history")}      Show past sessions
  ${chalk.cyan("/actions")}      Show this session's action log
  ${chalk.cyan("/model <key>")}  Switch model mid-session
  ${chalk.cyan("/clear")}        Clear screen
  ${chalk.cyan("/cwd")}          Show current working directory
  ${chalk.cyan("/exit")}         Exit Nyxo Code
${chalk.gray("  ─────────────────────────────────────────────")}
  ${chalk.gray("Type any message to chat. The agent can read/write")}
  ${chalk.gray("files and run commands automatically.")}
`);
}

// Prompt line
function getPrompt() {
  return chalk.bold.cyan("\n◉ nyxo") + chalk.gray(" › ") ;
}

module.exports = {
  startSpinner,
  updateSpinner,
  stopSpinner,
  clearSpinner,
  printUser,
  printAssistant,
  printToolCall,
  printToolResult,
  printError,
  printInfo,
  printSuccess,
  printWarning,
  printSep,
  printSessionHistory,
  printHelp,
  getPrompt,
};
