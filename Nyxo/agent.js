// src/agent.js
/**
 * Agent Loop:
 * 1. User sends message
 * 2. Build prompt (system + recall + skills + recent history + user msg)
 * 3. Call API (NyxoAI or custom worker)
 * 4. Parse response for [[RECALL:key=value]] blocks → silently persist
 * 5. Parse response for <tool_call> blocks → execute → feed result back → repeat
 * 6. If no tool call → show final answer, save to history
 * Max 12 tool iterations per user message (safety limit)
 */

const { ask } = require("./api");
const { buildPrompt, buildToolResultPrompt } = require("./context");
const { executeTool, parseToolCall, stripToolCall } = require("./tools");
const { addTurn, getTurns, logAction } = require("./history");
const { upsertRecall } = require("./config");
const ui = require("./ui");

const MAX_TOOL_LOOPS = 12;

// Regex to find [[RECALL:key=value]] anywhere in AI response
const RECALL_REGEX = /\[\[RECALL:([^\]=]+)=([^\]]+)\]\]/g;

/**
 * Silently extract and persist any [[RECALL:key=value]] blocks from AI response.
 * Returns the cleaned response text (blocks removed).
 */
function processRecallInstructions(text) {
  let match;
  const updates = [];
  while ((match = RECALL_REGEX.exec(text)) !== null) {
    const key   = match[1].trim();
    const value = match[2].trim();
    if (key && value) {
      upsertRecall(key, value);
      updates.push(`${key}=${value}`);
      logAction("recall_update", `${key}=${value}`);
    }
  }
  if (updates.length > 0) {
    ui.printInfo(`  📝 Recalled: ${updates.join(", ")}`);
  }
  // Strip recall blocks from visible output
  return text.replace(RECALL_REGEX, "").trim();
}

/**
 * Run a single user message through the agent loop.
 * @param {string} userMessage
 * @param {object} opts - { apiKey, modelKey, think, temperature, workerUrl }
 */
async function runAgent(userMessage, opts) {
  const { apiKey, modelKey, think = "LOW", temperature = 0.4, workerUrl = null } = opts;

  addTurn("user", userMessage);
  logAction("user_message", userMessage.slice(0, 100));

  let loopMessage = userMessage;
  let iterationCount = 0;
  let lastToolName = null;
  let lastToolResult = null;

  ui.startSpinner("Thinking…");

  while (iterationCount < MAX_TOOL_LOOPS) {
    iterationCount++;

    // Build the prompt
    let prompt;
    if (iterationCount === 1) {
      prompt = buildPrompt(getTurns().slice(0, -1), loopMessage);
    } else {
      prompt = buildToolResultPrompt(
        getTurns().slice(0, -1),
        lastToolName,
        lastToolResult,
        userMessage
      );
    }

    let response;
    try {
      response = await ask({
        apiKey,
        modelKey,
        message: prompt,
        think,
        temperature,
        workerUrl,
      });
    } catch (err) {
      ui.stopSpinner(false, "API Error");
      const msg = parseApiError(err);
      ui.printError(msg);
      logAction("api_error", msg);
      return;
    }

    // Process recall instructions silently (modifies recall.txt, strips tags)
    response = processRecallInstructions(response);

    // Check for tool call
    const toolCall = parseToolCall(response);

    if (toolCall) {
      ui.stopSpinner(true, "");
      ui.printToolCall(toolCall.tool, toolCall.args);
      logAction("tool_call", `${toolCall.tool}(${JSON.stringify(toolCall.args).slice(0, 80)})`);

      const result = await executeTool(toolCall.tool, toolCall.args);
      logAction("tool_result", result.slice(0, 150));
      ui.printToolResult(toolCall.tool, result);

      lastToolName = toolCall.tool;
      lastToolResult = result;

      const preamble = stripToolCall(response);
      if (preamble && preamble.length > 10) {
        ui.printAssistant(preamble);
      }

      ui.startSpinner(`Processing ${toolCall.tool} result…`);
      continue;
    }

    // No tool call → final answer
    ui.stopSpinner(true, "");

    const cleaned = stripToolCall(response).trim();
    if (cleaned) {
      ui.printAssistant(cleaned);
      addTurn("assistant", cleaned);
      logAction("assistant_response", cleaned.slice(0, 120));
    }
    return;
  }

  // Hit loop limit
  ui.stopSpinner(false, "");
  ui.printWarning(`Reached max tool iterations (${MAX_TOOL_LOOPS}). Stopping.`);
  logAction("max_iterations_hit", loopMessage.slice(0, 80));
}

function parseApiError(err) {
  if (err?.response?.data) {
    const d = err.response.data;
    return d?.error || d?.message || JSON.stringify(d).slice(0, 200);
  }
  return err?.message || "Unknown API error";
}

module.exports = { runAgent };
