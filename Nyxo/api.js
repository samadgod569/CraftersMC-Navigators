// src/api.js
const axios = require("axios");

const NYXO_BASE_URL = "https://nyxoai.vortexa.cloud";

/**
 * Sends a message to NyxoAI and returns the text response.
 */
async function askNyxo({ apiKey, modelKey, message, think = "LOW", temperature = 0.4 }) {
  const res = await axios.post(
    `${NYXO_BASE_URL}/api/v1/assistant`,
    {
      message,
      modelKey,
      think,
      temperature,
      memory: "",
      skills: "",
      crawling: [],
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 60000,
    }
  );

  const data = res.data;
  const modelData = data[modelKey] || data;
  const text =
    modelData?.choices?.[0]?.message?.content ||
    modelData?.choices?.[0]?.text ||
    modelData?.output ||
    modelData?.response ||
    modelData?.content ||
    (typeof modelData === "string" ? modelData : null) ||
    JSON.stringify(modelData);

  return text?.trim() || "(no response)";
}

/**
 * Sends a message to a custom worker API via GET ?question=...
 * The full prompt (with memory, skills, recall) is packed into the question param.
 */
async function askCustom({ workerUrl, message }) {
  const url = new URL(workerUrl);
  url.searchParams.set("question", message);

  const res = await axios.get(url.toString(), { timeout: 60000 });

  const data = res.data;

  // Try many common response shapes
  const text =
    (typeof data === "string" ? data : null) ||
    data?.response ||
    data?.answer ||
    data?.output ||
    data?.result ||
    data?.content ||
    data?.text ||
    data?.message ||
    data?.choices?.[0]?.message?.content ||
    data?.choices?.[0]?.text ||
    JSON.stringify(data);

  return text?.trim() || "(no response)";
}

/**
 * Unified ask — routes to NyxoAI or custom worker based on config.
 */
async function ask({ apiKey, modelKey, message, think = "LOW", temperature = 0.4, workerUrl = null }) {
  if (workerUrl) {
    return askCustom({ workerUrl, message });
  }
  return askNyxo({ apiKey, modelKey, message, think, temperature });
}

module.exports = { ask };
