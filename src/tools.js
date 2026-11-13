// Tool definitions the Claude agent can call, mapped to PayPal operations.
// Tools with `needsApproval: true` move money or contact customers, so the
// agent loop pauses and the human must click Approve in the UI first.
import * as ledger from "./ledger.js";

const item = {
  type: "object",
  properties: {
    name: { type: "string", description: "Line item name, e.g. 'Logo design'" },
    description: { type: "string" },
    quantity: { type: "number", description: "Defaults to 1" },
    unit_amount: { type: "number", description: "Price per unit, e.g. 450 or 19.99" },
  },
  required: ["name", "unit_amount"],
};

export const TOOLS = [
  {
    name: "create_invoice",
    description:
      "Create a DRAFT PayPal invoice for a customer. Does not notify anyone. Follow up with send_invoice to deliver it.",
    input_schema: {
      type: "object",
      properties: {
        recipient_email: { type: "string", description: "Customer email address" },
        recipient_name: { type: "string", description: "Customer full name, if known" },
        items: { type: "array", items: item, minItems: 1 },
        currency: { type: "string", description: "ISO currency code, default USD" },
        note: { type: "string", description: "Note shown to the customer on the invoice" },
        payment_term: {
          type: "string",
          enum: ["DUE_ON_RECEIPT", "NET_10", "NET_15", "NET_30", "NET_45", "NET_60", "NET_90", "NO_DUE_DATE"],
          description: "Default NET_30",
        },
      },
      required: ["recipient_email", "items"],
    },
  },
  {
    name: "send_invoice",
    description: "Email a DRAFT invoice to its recipient via PayPal. REQUIRES the user's approval in the app (handled automatically).",
    needsApproval: true,
    input_schema: {
      type: "object",
      properties: {
        invoice_id: { type: "string" },
        subject: { type: "string", description: "Email subject line" },
        note: { type: "string", description: "Short personal message in the email" },
      },
      required: ["invoice_id"],
    },
  },
  {
    name: "list_invoices",
    description: "List recent PayPal invoices, optionally filtered by status.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["DRAFT", "SENT", "SCHEDULED", "PAID", "MARKED_AS_PAID", "CANCELLED", "REFUNDED", "PARTIALLY_PAID", "PARTIALLY_REFUNDED", "UNPAID", "PAYMENT_PENDING"],
        },
        page_size: { type: "number", description: "1-100, default 20" },
      },
    },
  },
  {
    name: "get_invoice",
    description: "Get the latest status and details of one invoice.",
    input_schema: { type: "object", properties: { invoice_id: { type: "string" } }, required: ["invoice_id"] },
  },
  {
    name: "send_invoice_reminder",
    description: "Send a payment reminder email for an unpaid, already-sent invoice. REQUIRES approval.",
    needsApproval: true,
    input_schema: {
      type: "object",
      properties: {
        invoice_id: { type: "string" },
        subject: { type: "string" },
        note: { type: "string", description: "Polite reminder message" },
      },
      required: ["invoice_id"],
    },
  },
  {
    name: "cancel_invoice",
    description: "Cancel a sent invoice and notify the recipient. REQUIRES approval.",
    needsApproval: true,
    input_schema: {
      type: "object",
      properties: { invoice_id: { type: "string" }, note: { type: "string", description: "Reason shown to the customer" } },
      required: ["invoice_id"],
    },
  },
  {
    name: "create_payment_link",
    description:
      "Create a PayPal checkout order and return a shareable payment link (checkout_page). Use for one-off sales, deposits, tips, or anything that doesn't need a formal invoice.",
    input_schema: {
      type: "object",
      properties: {
        amount: { type: "number" },
        currency: { type: "string", description: "Default USD" },
        description: { type: "string", description: "What the buyer is paying for" },
      },
      required: ["amount", "description"],
    },
  },
  {
    name: "get_order_status",
    description: "Check a checkout order / payment link: whether it's been paid, the payer, and the capture_id needed for refunds.",
    input_schema: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
  },
  {
    name: "refund_payment",
    description: "Refund a captured PayPal payment fully or partially. REQUIRES approval. Find the capture_id with get_activity_ledger or get_order_status.",
    needsApproval: true,
    input_schema: {
      type: "object",
      properties: {
        capture_id: { type: "string" },
        amount: { type: "number", description: "Omit for a full refund" },
        currency: { type: "string", description: "Default USD" },
        note_to_payer: { type: "string" },
      },
      required: ["capture_id"],
    },
  },
  {
    name: "search_transactions",
    description: "Search the PayPal account's transaction history (Transaction Search API) for the last N days (max 31).",
    input_schema: { type: "object", properties: { days: { type: "number", description: "Default 30" } } },
  },
  {
    name: "get_activity_ledger",
    description:
      "Read PayPilot's local activity ledger: every invoice, payment link, captured payment (with capture_id) and refund made through this app, newest first, plus totals. Fast and always up to date.",
    input_schema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["invoice_created", "invoice_sent", "invoice_paid", "invoice_cancelled", "reminder_sent", "payment_link_created", "payment_captured", "refund"],
        },
        limit: { type: "number", description: "Default 30" },
      },
    },
  },
];

export const NEEDS_APPROVAL = new Set(TOOLS.filter((t) => t.needsApproval).map((t) => t.name));

/** Tool definitions in the shape the Messages API expects (strip our own flags). */
export const API_TOOLS = TOOLS.map(({ needsApproval, ...t }) => t);

/** Human-readable one-liner describing a pending action for the approval card. */
export function describeAction(name, input) {
  switch (name) {
    case "send_invoice":
      return `Email invoice ${input.invoice_id} to the customer${input.subject ? ` with subject "${input.subject}"` : ""}.`;
    case "send_invoice_reminder":
      return `Send a payment reminder for invoice ${input.invoice_id}.`;
    case "cancel_invoice":
      return `Cancel invoice ${input.invoice_id} and notify the customer.`;
    case "refund_payment":
      return input.amount
        ? `Refund ${Number(input.amount).toFixed(2)} ${input.currency || "USD"} on capture ${input.capture_id}.`
        : `Fully refund capture ${input.capture_id}.`;
    default:
      return `${name}(${JSON.stringify(input)})`;
  }
}

export async function runTool(paypal, name, input) {
  switch (name) {
    case "create_invoice":
      return paypal.createInvoice(input);
    case "send_invoice":
      return paypal.sendInvoice(input.invoice_id, input);
    case "list_invoices":
      return paypal.listInvoices(input);
    case "get_invoice":
      return paypal.getInvoice(input.invoice_id);
    case "send_invoice_reminder":
      return paypal.remindInvoice(input.invoice_id, input);
    case "cancel_invoice":
      return paypal.cancelInvoice(input.invoice_id, input);
    case "create_payment_link":
      return paypal.createOrder(input);
    case "get_order_status":
      return paypal.getOrder(input.order_id);
    case "refund_payment":
      return paypal.refundCapture(input.capture_id, input);
    case "search_transactions":
      return paypal.searchTransactions(input);
    case "get_activity_ledger":
      return { totals: ledger.summary(), events: ledger.list({ type: input.type, limit: input.limit ?? 30 }) };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
