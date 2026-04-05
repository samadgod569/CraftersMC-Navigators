// src/context.js
/**
 * Builds the minimal prompt sent to the AI.
 * Strategy: system header (static, small) + recent turns only + current message.
 * NEVER send full file contents inline — tools handle that on-demand.
 */

const { getFullSchema } = require("./tools");
const path = require("path");

const MAX_HISTORY_TURNS = 6;      // last N turns included
const MAX_TURN_CHARS = 1200;      // truncate long assistant responses in history

function buildSystemHeader(cwd) {
  return `You are Nyxo Code, an expert AI coding agent. You run in a terminal.
You can use tools to read files, write code, run commands, and solve tasks.
Always think step by step. Be concise but thorough.
CWD: ${cwd}

${getFullSchema()}`;
}

/**
 * @param {Array} history - [{role, content}]
 * @param {string} userMessage - current user message
 * @returns {string} - final prompt string
 */
function buildPrompt(history, userMessage) {
  const cwd    = process.cwd();
  const system = buildSystemHeader(cwd);

  // Take last N turns, truncate long assistant messages
  const recentTurns = history
    .slice(-MAX_HISTORY_TURNS * 2)
    .map((turn) => {
      let content = turn.content;
      if (turn.role === "assistant" && content.length > MAX_TURN_CHARS) {
        content = content.slice(0, MAX_TURN_CHARS) + "\n[...truncated for context]";
      }
      return `${turn.role === "user" ? "USER" : "ASSISTANT"}: ${content}`;
    })
    .join("\n\n");

  const parts = [system];
  if (recentTurns) parts.push("CONVERSATION HISTORY:\n" + recentTurns);
  parts.push("USER: " + userMessage);
  parts.push("ASSISTANT:");

  return parts.join("\n\n");
}

/**
 * Builds a lean tool-result prompt (mid-loop, not user-facing)
 */
function buildToolResultPrompt(history, toolName, toolResult, userMessage) {
  const cwd    = process.cwd();
  const system = buildSystemHeader(cwd);

  const truncatedResult =
    toolResult.length > 3000
      ? toolResult.slice(0, 3000) + "\n[...truncated]"
      : toolResult;

  const recentTurns = history
    .slice(-MAX_HISTORY_TURNS * 2)
    .map((t) => {
      let c = t.content;
      if (t.role === "assistant" && c.length > MAX_TURN_CHARS) {
        c = c.slice(0, MAX_TURN_CHARS) + "\n[...truncated]";
      }
      return `${t.role === "user" ? "USER" : "ASSISTANT"}: ${c}`;
    })
    .join("\n\n");

  const parts = [system];
  if (recentTurns) parts.push("CONVERSATION HISTORY:\n" + recentTurns);
  parts.push(`USER: ${userMessage}`);
  parts.push(`TOOL USED: ${toolName}\nTOOL RESULT:\n${truncatedResult}`);
  parts.push("ASSISTANT: (continue based on the tool result above)");

  return parts.join("\n\n");
}

module.exports = { buildPrompt, buildToolResultPrompt };
