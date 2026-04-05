// src/agent.js
/**
 * Agent Loop:
 * 1. User sends message
 * 2. Build lean prompt (system + recent history + user msg)
 * 3. Call NyxoAI API
 * 4. Parse response for <tool_call> blocks
 * 5. If tool call → execute → feed result back to AI → repeat
 * 6. If no tool call → show final answer, save to history
 * Max 12 tool iterations per user message (safety limit)
 */

const { ask } = require("./api");
const { buildPrompt, buildToolResultPrompt } = require("./context");
const { executeTool, parseToolCall, stripToolCall } = require("./tools");
const { addTurn, getTurns, logAction } = require("./history");
const ui = require("./ui");

const MAX_TOOL_LOOPS = 12;

/**
 * Run a single user message through the agent loop.
 * @param {string} userMessage
 * @param {object} opts - { apiKey, modelKey, think, temperature }
 */
async function runAgent(userMessage, opts) {
  const { apiKey, modelKey, think = "LOW", temperature = 0.4 } = opts;

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
      });
    } catch (err) {
      ui.stopSpinner(false, "API Error");
      const msg = parseApiError(err);
      ui.printError(msg);
      logAction("api_error", msg);
      return;
    }

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

      // Strip the tool_call block, keep any preamble text from the AI
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
