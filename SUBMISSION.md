# Devpost submission draft: PayPilot

## Tagline
An AI back-office that invoices, collects, tracks and refunds through PayPal. Just tell it what you need.

## Inspiration
Freelancers and small shops lose hours to billing admin: writing invoices, sending payment links, chasing late payers, looking up transactions to refund. Each step means clicking through dashboards. We wanted to say it in one sentence and have it done safely, with a human still in control of anything that touches money.

## What it does
PayPilot is a chat agent connected to a business's PayPal account (sandbox):
- **Invoicing from natural language.** "Bill Jane $1,200 for the redesign and $300 for hosting, NET 15" becomes a real PayPal invoice with line items and terms, sent after you approve.
- **Payment links.** It creates a PayPal Checkout order and a hosted checkout page with PayPal Smart Buttons. When the buyer pays, the capture appears instantly on the dashboard.
- **Collections.** It finds unpaid invoices and sends polite reminders or cancels invoices, each one approved by you.
- **Refunds.** "Refund $20 of Sam's payment" makes it look up the capture ID and issue a partial or full refund.
- **Insights.** "How's business this month?" gives collected, outstanding, refunded and net totals, and flags invoices that need follow-up.
- **Human-in-the-loop approvals.** Every action that emails a customer or moves money pauses the agent and shows an Approve/Decline card.
- **Transparent tool trace.** Every PayPal API call the agent made is shown inline with its inputs and outputs.

## How we built it
- **Claude (`claude-opus-5-5`)** via the Anthropic TypeScript SDK runs a tool-use loop over 11 PayPal tools. Gated tools (send, remind, cancel, refund) pause the loop. The server stores the pending `tool_use` blocks and resumes with the matching `tool_result`s once the user decides. Adaptive thinking and server-side refusal fallbacks are enabled.
- **PayPal REST APIs (sandbox):** OAuth2, Invoicing v2, Orders v2, Payments v2 refunds, Transaction Search, and the PayPal JS SDK Smart Buttons on the checkout page.
- **Node.js + Express** backend with a vanilla JS frontend. A local activity ledger gives real-time totals and capture IDs, because sandbox reporting lags.
- **Mock mode** mirrors the PayPal client interface so anyone can try it without credentials.

## Challenges
- Pausing an agent loop mid-turn for human approval while keeping the conversation valid. Every `tool_use` needs exactly one `tool_result`, including when the user ignores the card and types something new.
- Sandbox Transaction Search lags behind real time, so we added a local ledger the agent can query.

## What's next
Webhooks for live invoice-paid events, subscriptions/recurring billing, multi-currency reports, and Slack/email entry points.

## Built with
paypal-rest-api, paypal-invoicing, paypal-checkout, paypal-js-sdk, claude, anthropic, node.js, express, javascript

## Demo video script (under 3 min)
1. **0:00 Intro (15s):** the problem, and the dashboard in sandbox mode.
2. **0:15 Invoice (45s):** type the Jane invoice prompt → show the tool trace → Approve → open the PayPal invoice link.
3. **1:00 Payment link (45s):** "$49 consulting call link" → open the checkout page → pay with the sandbox buyer → dashboard updates.
4. **1:45 Refund (30s):** "Refund $20 of that payment" → approval card → Approve → ledger shows the refund.
5. **2:15 Insights (30s):** "How is business this month?" → summary, then wrap up.
