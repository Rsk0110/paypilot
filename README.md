# PayPilot — an AI back-office for getting paid with PayPal

PayPilot is a chat-based agent for freelancers and small businesses. You tell it, in plain English, who to bill or what to collect, and it does the PayPal work for you: it drafts and sends invoices, makes payment links, chases unpaid invoices, reports on how business is going, and handles refunds. It **asks you to approve** anything that emails a customer or moves money.

> "Invoice jane@example.com $1,200 for the website redesign and $300 for hosting setup, due in 15 days"
>
> → drafts a PayPal invoice → shows you an **Approve / Decline** card → sends it through PayPal → it appears on the dashboard.

Built for the **PayPal AI Hackathon** with the **PayPal REST APIs (sandbox)** and **Claude (Anthropic)**.

---

## Features

| | |
|---|---|
| 🧾 **Natural-language invoicing** | Parses customers, line items, quantities, prices and payment terms from a sentence, then creates a PayPal invoice (Invoicing API v2). |
| 🔗 **Instant payment links** | One-off sales, deposits and tips become a PayPal Checkout order with a shareable checkout page (Orders API v2 + PayPal JS SDK Smart Buttons). |
| 🔔 **Collections** | "Who hasn't paid?": lists unpaid invoices, and drafts and sends reminders or cancellations. |
| ↩️ **Refunds** | "Refund Sam's last payment": finds the capture ID in the ledger and issues a full or partial refund (Payments API v2). |
| 📊 **Business insights** | Answers questions like "how is business this month?" from the activity ledger, the invoice list and PayPal Transaction Search. |
| 🔒 **Human-in-the-loop safety** | Sending, reminding, cancelling and refunding are *gated tools*. The agent loop pauses and the UI shows an approval card, so nothing irreversible happens without a click. |
| 🔍 **Transparent tool trace** | Every PayPal API call the agent makes is shown inline with its inputs and results, so you can see exactly what happened. |
| 🧪 **Mock mode** | No PayPal keys? It runs anyway with a simulated PayPal backend, so judges can try it in 60 seconds. |

## How it works

```
Browser (chat + dashboard + checkout page)
   │  POST /api/chat, /api/approve
   ▼
Express server ──► Claude agent loop (claude-opus-5-5, tool use, adaptive thinking)
                     │   tools: create_invoice, send_invoice*, list_invoices, get_invoice,
                     │          send_invoice_reminder*, cancel_invoice*, create_payment_link,
                     │          get_order_status, refund_payment*, search_transactions,
                     │          get_activity_ledger          (* = needs human approval)
                     ▼
                  PayPal REST (sandbox): OAuth2 · Invoicing v2 · Orders v2 · Payments v2 · Reporting
                     ▼
                  Local activity ledger (data/ledger.json) → dashboard totals & capture IDs
```

1. Your message goes to Claude with the PayPal tool definitions.
2. Claude decides which tools to call. Safe tools (reads, drafts, payment links) run right away.
3. If Claude calls a gated tool, the loop **pauses** and saves its state. The UI shows an approval card. On **Approve** the server runs the PayPal call and resumes the loop. On **Decline** Claude is told the action was declined.
4. Buyers pay on `/pay/:orderId` with PayPal Smart Buttons. The server captures the order, and the payment shows up in the ledger with its capture ID, ready for refunds.

## Quick start

**Requirements:** Node.js 18.17+ and an [Anthropic API key](https://console.anthropic.com/).

```bash
git clone <your-repo-url> paypilot
cd paypilot
npm install
cp .env.example .env      # then edit .env
npm start
```

Open **http://localhost:3000**.

### Connect the PayPal sandbox (recommended)

1. Log in to the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/) → **Apps & Credentials** → **Sandbox** → **Create App** (type: Merchant).
2. Copy the **Client ID** and **Secret** into `.env` as `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.
3. In the app's settings, make sure **Invoicing** and **Transaction search** are enabled under features.
4. To pay as a customer, use the **sandbox Personal (buyer) account** from **Testing Tools → Sandbox Accounts** when the PayPal popup asks you to log in.
5. Restart `npm start`. The header badge changes from *Mock mode* to *PayPal sandbox*.

If you leave the PayPal keys empty, PayPilot runs in **mock mode**. Every feature works against a simulated PayPal backend, and the checkout and invoice pages get "simulate payment" buttons.

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | Claude API key |
| `CLAUDE_MODEL` | | Defaults to `claude-opus-5-5` |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | | Sandbox REST app credentials (empty = mock mode) |
| `PUBLIC_URL` | | Base URL for checkout links and PayPal return URLs (default `http://localhost:3000`) |
| `BUSINESS_NAME` | | Shown on invoices, checkout pages and to the agent |
| `PORT` | | Default `3000` |

## Try these prompts

- `Invoice Jane Doe (jane@example.com) $1,200 for a website redesign and $300 for hosting setup, NET 15`
- `Make a $49 payment link for a 1-hour consulting call` → open the link and pay with your sandbox buyer
- `Did anyone pay the consulting link yet?`
- `Which invoices are still unpaid? Send a friendly reminder to each.`
- `Refund $20 of the consulting payment, the call ran short`
- `How is business this month?`

## Project structure

```
src/
  server.js   Express app: API routes, checkout pages, PayPal return handler
  agent.js    Claude tool-use loop with the pause/resume approval gate
  tools.js    Tool schemas + dispatch to PayPal operations
  paypal.js   PayPal REST client (OAuth, Invoicing, Orders, Payments, Reporting) + mock client
  ledger.js   Local activity ledger + dashboard totals
public/
  index.html, app.js, styles.css   Chat UI, approval cards, tool trace, activity dashboard
  pay.html                         Hosted checkout page with PayPal Smart Buttons
```

## Tech used

- **PayPal Developer Platform (sandbox):** OAuth 2.0 client credentials, Invoicing API v2 (generate number, create, send, remind, cancel, list/search), Orders API v2 (create, get, capture), Payments API v2 (refund captures), Transaction Search API, and the PayPal JavaScript SDK (Smart Payment Buttons).
- **Claude by Anthropic:** `claude-opus-5-5` through the official `@anthropic-ai/sdk`, with client-side tool use, adaptive thinking, and server-side refusal fallbacks.
- **Node.js + Express** for the backend and **vanilla HTML/CSS/JS** for the frontend. No build step.

## Notes & limitations

- Sandbox only. No real money moves.
- Conversation state lives in memory and resets when the server restarts. The activity ledger persists in `data/ledger.json`.
- PayPal's Transaction Search data can lag a few hours in sandbox. The local ledger is real-time.

## License

[MIT](LICENSE)
