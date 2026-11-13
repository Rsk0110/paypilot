import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPayPal } from "./paypal.js";
import { chat, decide, resetSession } from "./agent.js";
import * as ledger from "./ledger.js";

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const paypal = createPayPal({
  clientId: process.env.PAYPAL_CLIENT_ID,
  clientSecret: process.env.PAYPAL_CLIENT_SECRET,
  publicUrl: PUBLIC_URL,
  businessName: process.env.BUSINESS_NAME || "Acme Design Studio",
});

const app = express();
app.use(express.json({ limit: "200kb" }));
app.use(express.static(PUBLIC_DIR));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(err);
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    res.status(status).json({ error: friendlyError(err) });
  });

function friendlyError(err) {
  const msg = err?.message || String(err);
  if (/api[_ -]?key|authentication|x-api-key/i.test(msg)) {
    return "Claude API key missing or invalid. Set ANTHROPIC_API_KEY in your .env file and restart.";
  }
  return msg;
}

// ---- App config for the browser ----
app.get("/api/config", (_req, res) => {
  res.json({
    mode: paypal.mode,
    paypalClientId: paypal.clientId,
    businessName: paypal.businessName,
    claudeReady: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  });
});

// ---- Agent ----
app.post(
  "/api/chat",
  wrap(async (req, res) => {
    const { sessionId, message } = req.body || {};
    if (!sessionId || !message?.trim()) return res.status(400).json({ error: "sessionId and message are required" });
    res.json(await chat(paypal, sessionId, message.trim()));
  })
);

app.post(
  "/api/approve",
  wrap(async (req, res) => {
    const { sessionId, toolUseId, approved } = req.body || {};
    res.json(await decide(paypal, sessionId, toolUseId, Boolean(approved)));
  })
);

app.post("/api/reset", (req, res) => {
  resetSession(req.body?.sessionId);
  res.json({ ok: true });
});

// ---- Dashboard ----
app.get("/api/ledger", (_req, res) => {
  res.json({ totals: ledger.summary(), events: ledger.list({ limit: 40 }) });
});

// ---- Checkout (payment links) ----
// Direct endpoint (no AI) - handy for testing the checkout flow.
app.post(
  "/api/payment-links",
  wrap(async (req, res) => {
    const { amount, currency, description } = req.body || {};
    if (!(Number(amount) > 0)) return res.status(400).json({ error: "amount must be a positive number" });
    res.json(await paypal.createOrder({ amount: Number(amount), currency: currency || "USD", description: description || "Payment" }));
  })
);

app.get(
  "/api/orders/:id",
  wrap(async (req, res) => res.json(await paypal.getOrder(req.params.id)))
);

app.post(
  "/api/orders/:id/capture",
  wrap(async (req, res) => res.json(await paypal.captureOrder(req.params.id)))
);

app.get("/pay/:id", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "pay.html")));

// Return URL when a buyer approves on PayPal's hosted page (approve link).
app.get(
  "/paypal/return",
  wrap(async (req, res) => {
    const orderId = req.query.token;
    if (!orderId) return res.redirect("/");
    try {
      const order = await paypal.getOrder(orderId);
      if (order.status === "APPROVED") await paypal.captureOrder(orderId);
    } catch (err) {
      console.error("Capture on return failed:", err.message);
    }
    res.redirect(`/pay/${encodeURIComponent(orderId)}`);
  })
);

app.get("/paypal/cancel", (req, res) => {
  const orderId = req.query.token;
  res.redirect(orderId ? `/pay/${encodeURIComponent(orderId)}?cancelled=1` : "/");
});

// Mock-mode invoice page so the whole flow works without PayPal credentials.
app.get(
  "/mock/invoice/:id",
  wrap(async (req, res) => {
    if (paypal.mode !== "mock") return res.redirect("/");
    const inv = await paypal.getInvoice(req.params.id);
    res.type("html").send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Invoice ${inv.number}</title><link rel="stylesheet" href="/styles.css">
<body class="pay-body"><main class="pay-card">
<div class="badge mock">Mock mode</div>
<h1>Invoice ${inv.number}</h1>
<p class="muted">From ${paypal.businessName} to ${inv.recipient_email}</p>
<ul class="pay-items">${(inv.items || []).map((i) => `<li><span>${escapeHtml(i.name)} × ${i.quantity}</span><b>$${i.unit_amount}</b></li>`).join("")}</ul>
<p class="pay-total">Total <b>${inv.amount} ${inv.currency}</b></p>
<p>Status: <b>${inv.status}</b></p>
${inv.status === "SENT" ? `<form method="post" action="/mock/invoice/${inv.id}/pay"><button class="btn primary wide">Simulate paying this invoice</button></form>` : ""}
</main></body>`);
  })
);

app.post(
  "/mock/invoice/:id/pay",
  wrap(async (req, res) => {
    if (paypal.mode !== "mock") return res.redirect("/");
    await paypal.markInvoicePaid(req.params.id);
    res.redirect(`/mock/invoice/${encodeURIComponent(req.params.id)}`);
  })
);

function escapeHtml(s = "") {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

app.listen(PORT, () => {
  console.log(`\n  PayPilot running at ${PUBLIC_URL}`);
  console.log(`  PayPal: ${paypal.mode === "mock" ? "MOCK mode (set PAYPAL_CLIENT_ID/SECRET for sandbox)" : "sandbox"}`);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.log("  WARNING: ANTHROPIC_API_KEY is not set - the chat agent will not work until you add it to .env");
  }
  console.log("");
});
