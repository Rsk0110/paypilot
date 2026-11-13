// The PayPilot agent: a Claude tool-use loop over PayPal tools, with a
// human-in-the-loop approval gate for anything that moves money or emails a
// customer. Conversations live in memory, keyed by a session ID from the browser.
import Anthropic from "@anthropic-ai/sdk";
import { API_TOOLS, NEEDS_APPROVAL, describeAction, runTool } from "./tools.js";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const MAX_STEPS = 15;

let _client;
const anthropic = () => (_client ||= new Anthropic());
const sessions = new Map();

function systemPrompt(paypal) {
  return `You are PayPilot, an AI back-office assistant for "${paypal.businessName}", a small business that gets paid through PayPal.
You act on the business's PayPal ${paypal.mode === "mock" ? "account in MOCK mode (simulated, no real API calls)" : "SANDBOX account (test money only)"} using your tools.

How to work:
- Act, don't just describe: when the user asks you to bill, collect, check, remind or refund, call the tools.
- Never invent IDs, amounts, links, emails or statuses. Use only what the user said or what tools returned.
- Billing someone usually means: create_invoice (draft) then send_invoice. Sending, reminding, cancelling and refunding are gated: the app shows the user an Approve/Decline card, so call those tools directly instead of asking "shall I?" in text.
- If a required detail is missing (e.g. the customer's email or the price), ask one short question. Otherwise use sensible defaults (USD, NET_30).
- For quick one-off payments, deposits or tips, prefer create_payment_link and share the checkout_page URL.
- To refund, find the capture_id via get_activity_ledger or get_order_status first.
- For "how is business" / reporting questions, combine get_activity_ledger and list_invoices; give totals and call out anything overdue or needing follow-up.
- If a tool errors, explain briefly in plain language and suggest a fix.

Reply style: concise, friendly Markdown. Bold key amounts, include clickable links (payment links, invoice links), and use short bullet lists for multiple items.
Today's date is ${new Date().toISOString().slice(0, 10)}.`;
}

function getSession(id) {
  if (!sessions.has(id)) sessions.set(id, { messages: [], pending: null });
  return sessions.get(id);
}

export function resetSession(id) {
  sessions.delete(id);
}

const textOf = (content) =>
  content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

async function execute(paypal, use, trace) {
  const started = Date.now();
  try {
    const result = await runTool(paypal, use.name, use.input);
    trace.push({ tool: use.name, input: use.input, ok: true, result, ms: Date.now() - started });
    return { type: "tool_result", tool_use_id: use.id, content: JSON.stringify(result) };
  } catch (err) {
    trace.push({ tool: use.name, input: use.input, ok: false, error: err.message, ms: Date.now() - started });
    return { type: "tool_result", tool_use_id: use.id, content: `Error: ${err.message}`, is_error: true };
  }
}

/** Run the agent until it replies in text or pauses for an approval. */
async function loop(paypal, session, trace) {
  const replies = [];
  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await anthropic().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      // Server-side fallback: if a safety classifier declines, the API retries on a fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: systemPrompt(paypal),
      tools: API_TOOLS,
      messages: session.messages,
    });
    // Append the full content (thinking blocks included) to keep history valid.
    session.messages.push({ role: "assistant", content: response.content });
    const text = textOf(response.content);
    if (text) replies.push(text);

    if (response.stop_reason === "refusal") {
      replies.push("Sorry - I can't help with that request.");
      return { reply: replies.join("\n\n"), trace, approvals: [] };
    }
    if (response.stop_reason !== "tool_use") {
      return { reply: replies.join("\n\n"), trace, approvals: [] };
    }

    const uses = response.content.filter((b) => b.type === "tool_use");
    const results = {};
    const gated = [];
    await Promise.all(
      uses.map(async (use) => {
        if (NEEDS_APPROVAL.has(use.name)) gated.push(use);
        else results[use.id] = await execute(paypal, use, trace);
      })
    );

    if (gated.length) {
      session.pending = { uses, results, gated: new Set(gated.map((g) => g.id)) };
      return {
        reply: replies.join("\n\n"),
        trace,
        approvals: gated.map((g) => ({ id: g.id, tool: g.name, input: g.input, summary: describeAction(g.name, g.input) })),
      };
    }
    // All tool results go back in a single user message.
    session.messages.push({ role: "user", content: uses.map((u) => results[u.id]) });
  }
  return { reply: replies.join("\n\n") + "\n\n_(Stopped after too many steps.)_", trace, approvals: [] };
}

function pendingApprovals(session) {
  if (!session.pending) return [];
  return session.pending.uses
    .filter((u) => session.pending.gated.has(u.id) && !session.pending.results[u.id])
    .map((u) => ({ id: u.id, tool: u.name, input: u.input, summary: describeAction(u.name, u.input) }));
}

export async function chat(paypal, sessionId, userText) {
  const session = getSession(sessionId);
  const trace = [];
  if (session.pending) {
    // The user moved on without deciding: decline whatever is still pending.
    const { uses, results } = session.pending;
    for (const u of uses) {
      results[u.id] ||= {
        type: "tool_result",
        tool_use_id: u.id,
        content: "The user did not approve this action (they sent a new message instead). It was NOT executed.",
        is_error: true,
      };
    }
    session.messages.push({ role: "user", content: [...uses.map((u) => results[u.id]), { type: "text", text: userText }] });
    session.pending = null;
  } else {
    session.messages.push({ role: "user", content: userText });
  }
  return loop(paypal, session, trace);
}

export async function decide(paypal, sessionId, toolUseId, approved) {
  const session = getSession(sessionId);
  const p = session.pending;
  if (!p || !p.gated.has(toolUseId)) throw new Error("No pending action with that ID");
  if (p.results[toolUseId]) throw new Error("That action was already decided");
  const use = p.uses.find((u) => u.id === toolUseId);
  const trace = [];
  if (approved) {
    p.results[toolUseId] = await execute(paypal, use, trace);
  } else {
    p.results[toolUseId] = {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: "The user DECLINED this action. It was not executed. Acknowledge briefly and ask if they want something different.",
      is_error: true,
    };
    trace.push({ tool: use.name, input: use.input, ok: false, error: "Declined by user", ms: 0 });
  }

  const remaining = pendingApprovals(session);
  if (remaining.length) return { reply: "", trace, approvals: remaining, waiting: true };

  session.messages.push({ role: "user", content: p.uses.map((u) => p.results[u.id]) });
  session.pending = null;
  const out = await loop(paypal, session, trace);
  return out;
}
