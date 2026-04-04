// src/ascii.js
const chalk = require("chalk");

const LOGO = `
${chalk.cyan("        · · ·")}
${chalk.cyan("      ·")} ${chalk.blue("▓▓")} ${chalk.cyan("·")}       ${chalk.bold.cyan("███╗   ██╗██╗   ██╗██╗  ██╗ ██████╗")}
${chalk.cyan("    ·")}  ${chalk.blue("░")}${chalk.cyan("(*)")}${chalk.blue("░")}  ${chalk.cyan("·")}     ${chalk.bold.cyan("████╗  ██║╚██╗ ██╔╝╚██╗██╔╝██╔═══██╗")}
${chalk.blue("   /~~")}${chalk.white("◉")}${chalk.cyan("~~~~")}${chalk.magenta("◉")}${chalk.blue("~~\\")}    ${chalk.bold.cyan("██╔██╗ ██║ ╚████╔╝  ╚███╔╝ ██║   ██║")}
${chalk.blue("  |")}  ${chalk.cyan("\\  ✦  /")}  ${chalk.magenta("|")}    ${chalk.bold.cyan("██║╚██╗██║  ╚██╔╝   ██╔██╗ ██║   ██║")}
${chalk.blue("   \\~~")}${chalk.magenta("◉")}${chalk.cyan("~~~~")}${chalk.white("◉")}${chalk.magenta("~~/​")}     ${chalk.bold.cyan("██║ ╚████║   ██║   ██╔╝ ██╗╚██████╔╝")}
${chalk.magenta("    ·")}  ${chalk.blue("░·░")}  ${chalk.magenta("·")}      ${chalk.bold.cyan("╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝")}
${chalk.magenta("      · · ·")}        ${chalk.bold.magenta(" C O D E")}  ${chalk.gray("v1.0.0")}
`;

const TAGLINE = chalk.gray("  Orbital AI Agent · Reads · Writes · Executes · Thinks\n");

const SEPARATOR = chalk.gray("─".repeat(60));

function printBanner() {
  console.log(LOGO);
  console.log(TAGLINE);
  console.log(SEPARATOR);
}

function printMini() {
  console.log(
    chalk.cyan("◉") +
    chalk.bold.white(" Nyxo Code") +
    chalk.gray(" v1.0.0") +
    chalk.gray(" · AI Agent CLI")
  );
}

module.exports = { printBanner, printMini, SEPARATOR };
