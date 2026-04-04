// src/api.js
const axios = require("axios");

const BASE_URL = "https://nyxoai.vortexa.cloud";

/**
 * Sends a message to NyxoAI and returns the text response.
 * Keeps the payload lean — only what the model needs.
 */
async function ask({ apiKey, modelKey, message, think = "LOW", temperature = 0.4 }) {
  const res = await axios.post(
    `${BASE_URL}/api/v1/assistant`,
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

  // Extract text from all known response shapes
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

module.exports = { ask };
