// src/context.js
/**
 * Builds the prompt sent to the AI.
 * Includes: system header, recall memory, skills, recent history, current message.
 *
 * recall.txt  — AI-managed persistent memory (auto-updated by AI instructions)
 * skills.txt  — User-written skills/instructions injected verbatim
 */

const { getFullSchema } = require("./tools");
const { loadRecall, loadSkills } = require("./config");

const MAX_HISTORY_TURNS = 6;
const MAX_TURN_CHARS = 1200;

function buildSystemHeader(cwd) {
  return `You are Nyxo Code, an expert AI coding agent. You run in a terminal.
You can use tools to read files, write code, run commands, and solve tasks.
Always think step by step. Be concise but thorough.
CWD: ${cwd}

${getFullSchema()}`;
}

/**
 * Builds the recall block injected into every prompt.
 * Reminds the AI it can update recall via RECALL_UPDATE instruction.
 */
function buildRecallBlock() {
  const recall = loadRecall();
  const lines = [
    "=== RECALL MEMORY ===",
    "This is your persistent memory across sessions. It is stored in ~/.nyxo/recall.txt.",
    "You MUST read this before answering — it may contain API keys, tokens, or user preferences.",
    "To add/update a memory, output this anywhere in your response (will be silently processed):",
    "  [[RECALL:key=value]]",
    "Example: [[RECALL:github_token=ghp_abc123]]",
    "Keys must be single words or snake_case. Values can be anything on one line.",
    "",
  ];
  if (recall) {
    lines.push("Current recall entries:");
    lines.push(recall);
  } else {
    lines.push("(No recall entries yet.)");
  }
  lines.push("=== END RECALL ===");
  return lines.join("\n");
}

/**
 * Builds the skills block injected when skills.txt exists.
 */
function buildSkillsBlock() {
  const skills = loadSkills();
  if (!skills) return null;
  return [
    "=== USER SKILLS & INSTRUCTIONS ===",
    "The user has defined custom skills/behaviors. Always follow these:",
    "",
    skills,
    "=== END SKILLS ===",
  ].join("\n");
}

/**
 * @param {Array} history - [{role, content}]
 * @param {string} userMessage - current user message
 * @returns {string} - final prompt string
 */
function buildPrompt(history, userMessage) {
  const cwd    = process.cwd();
  const system = buildSystemHeader(cwd);
  const recall = buildRecallBlock();
  const skills = buildSkillsBlock();

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

  const parts = [system, recall];
  if (skills) parts.push(skills);
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
  const recall = buildRecallBlock();
  const skills = buildSkillsBlock();

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

  const parts = [system, recall];
  if (skills) parts.push(skills);
  if (recentTurns) parts.push("CONVERSATION HISTORY:\n" + recentTurns);
  parts.push(`USER: ${userMessage}`);
  parts.push(`TOOL USED: ${toolName}\nTOOL RESULT:\n${truncatedResult}`);
  parts.push("ASSISTANT: (continue based on the tool result above)");

  return parts.join("\n\n");
}

module.exports = { buildPrompt, buildToolResultPrompt };
