const express = require("express");
const cors = require("cors");

const app = express();

// ============================
// CORS ENABLED
// ============================
app.use(cors({
  origin: "*", // or restrict later to Tebex domains
  methods: ["POST", "GET"],
}));

// ============================
// JSON PARSER
// ============================
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// ============================
// Tebex Webhook Endpoint
// ============================
app.post("/tebex-webhook", (req, res) => {
  const data = req.body;

  console.log("🔥 WEBHOOK HIT:", data);

  // ============================
  // VALIDATION WEBHOOK
  // ============================
  if (data.type === "validation.webhook") {
    console.log("✔ Validation request received");

    return res.status(200).json({
      id: data.id
    });
  }

  // ============================
  // PAYMENT COMPLETED
  // ============================
  if (data.type === "payment.completed") {
    const s = data.subject;

    const email = s?.customer?.email;
    const username = s?.customer?.username?.username;

    const plan = s?.products?.[0]?.name;
    const price = s?.price?.amount;
    const expiry = s?.products?.[0]?.expires_at;

    console.log("💳 NEW PAYMENT RECEIVED:");
    console.log({ email, username, plan, price, expiry });

    // 👉 connect VPS logic here
  }

  return res.sendStatus(200);
});

// ============================
// SERVER START
// ============================
app.listen(8069, () => {
  console.log("🚀 Webhook server running on port 8069");
});
