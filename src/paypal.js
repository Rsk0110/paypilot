// PayPal REST client (sandbox) + an in-memory mock with the same interface.
// Real mode is used when PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are set.
import crypto from "node:crypto";
import * as ledger from "./ledger.js";

const SANDBOX = "https://api-m.sandbox.paypal.com";

const money = (v) => Number(v).toFixed(2);

function splitName(full = "") {
  const parts = String(full).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return undefined;
  return { given_name: parts[0], surname: parts.slice(1).join(" ") || undefined };
}

function paypalDate(d) {
  // PayPal reporting wants e.g. 2026-11-05T00:00:00-0000
  return d.toISOString().replace(/\.\d{3}Z$/, "-0000");
}

/** Normalised view of an invoice so the model gets compact, consistent data. */
export function summarizeInvoice(inv) {
  const r = inv.primary_recipients?.[0]?.billing_info;
  return {
    id: inv.id,
    number: inv.detail?.invoice_number,
    status: inv.status,
    recipient_email: r?.email_address,
    recipient_name: [r?.name?.given_name, r?.name?.surname].filter(Boolean).join(" ") || undefined,
    amount: inv.amount?.value,
    currency: inv.amount?.currency_code || inv.detail?.currency_code,
    due_amount: inv.due_amount?.value,
    payment_term: inv.detail?.payment_term?.term_type,
    due_date: inv.detail?.payment_term?.due_date,
    invoice_date: inv.detail?.invoice_date,
    payer_view_url: inv.detail?.metadata?.recipient_view_url,
    items: inv.items?.map((i) => ({ name: i.name, quantity: i.quantity, unit_amount: i.unit_amount?.value })),
  };
}

function summarizeOrder(order) {
  const pu = order.purchase_units?.[0] || {};
  const capture = pu.payments?.captures?.[0];
  const refunds = pu.payments?.refunds || [];
  return {
    id: order.id,
    status: order.status,
    amount: pu.amount?.value,
    currency: pu.amount?.currency_code,
    description: pu.description,
    payer_email: order.payer?.email_address,
    payer_name: [order.payer?.name?.given_name, order.payer?.name?.surname].filter(Boolean).join(" ") || undefined,
    capture_id: capture?.id,
    capture_status: capture?.status,
    refunds: refunds.map((r) => ({ id: r.id, status: r.status, amount: r.amount?.value })),
    paypal_approve_url: order.links?.find((l) => l.rel === "approve" || l.rel === "payer-action")?.href,
  };
}

// ---------------------------------------------------------------------------
// Real PayPal sandbox client
// ---------------------------------------------------------------------------
class PayPalClient {
  constructor({ clientId, clientSecret, publicUrl, businessName }) {
    this.mode = "sandbox";
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.publicUrl = publicUrl;
    this.businessName = businessName;
    this._token = null;
  }

  async token() {
    if (this._token && this._token.expiresAt > Date.now() + 60_000) return this._token.value;
    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const res = await fetch(`${SANDBOX}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`PayPal auth failed (${res.status}): ${data.error_description || res.statusText}`);
    this._token = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return this._token.value;
  }

  async request(method, path, body, extraHeaders = {}) {
    const headers = {
      Authorization: `Bearer ${await this.token()}`,
      "Content-Type": "application/json",
      ...extraHeaders,
    };
    if (method === "POST") headers["PayPal-Request-Id"] = crypto.randomUUID();
    const res = await fetch(`${SANDBOX}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const details = (data.details || []).map((d) => `${d.issue}${d.description ? `: ${d.description}` : ""}`).join("; ");
      throw new Error(
        `PayPal ${res.status} ${data.name || ""} - ${data.message || data.error_description || res.statusText}${details ? ` (${details})` : ""}`
      );
    }
    return data;
  }

  // ---- Invoicing v2 ----
  async createInvoice({ recipient_email, recipient_name, items, currency = "USD", note, payment_term = "NET_30" }) {
    const { invoice_number } = await this.request("POST", "/v2/invoicing/generate-next-invoice-number");
    const body = {
      detail: {
        invoice_number,
        currency_code: currency,
        note: note || `Thank you for your business! - ${this.businessName}`,
        payment_term: { term_type: payment_term },
      },
      primary_recipients: [
        { billing_info: { email_address: recipient_email, name: splitName(recipient_name) } },
      ],
      items: items.map((i) => ({
        name: i.name,
        description: i.description,
        quantity: String(i.quantity ?? 1),
        unit_amount: { currency_code: currency, value: money(i.unit_amount) },
        unit_of_measure: "QUANTITY",
      })),
    };
    let inv = await this.request("POST", "/v2/invoicing/invoices", body, { Prefer: "return=representation" });
    if (!inv.id && inv.href) inv = await this.request("GET", new URL(inv.href).pathname);
    const s = summarizeInvoice(inv);
    ledger.record({ type: "invoice_created", ref: s.id, label: `${s.number} draft for ${recipient_email}`, amount: s.amount, currency: s.currency });
    return s;
  }

  async sendInvoice(id, { subject, note } = {}) {
    await this.request("POST", `/v2/invoicing/invoices/${id}/send`, {
      send_to_invoicer: false,
      send_to_recipient: true,
      subject,
      note,
    });
    const s = summarizeInvoice(await this.request("GET", `/v2/invoicing/invoices/${id}`));
    ledger.record({ type: "invoice_sent", ref: s.id, label: `${s.number} sent to ${s.recipient_email}`, amount: s.amount, currency: s.currency, link: s.payer_view_url });
    return s;
  }

  async getInvoice(id) {
    const s = summarizeInvoice(await this.request("GET", `/v2/invoicing/invoices/${id}`));
    if (s.status === "PAID" && !ledger.list({ type: "invoice_paid", limit: 500 }).some((e) => e.ref === s.id)) {
      ledger.record({ type: "invoice_paid", ref: s.id, label: `${s.number} paid by ${s.recipient_email}`, amount: s.amount, currency: s.currency });
    }
    return s;
  }

  async listInvoices({ page_size = 20, status } = {}) {
    let data;
    if (status) {
      data = await this.request("POST", `/v2/invoicing/search-invoices?page_size=${page_size}&total_required=true`, { status: [status] });
    } else {
      data = await this.request("GET", `/v2/invoicing/invoices?page_size=${page_size}&total_required=true`);
    }
    return { total: data.total_items, invoices: (data.items || []).map(summarizeInvoice) };
  }

  async remindInvoice(id, { subject, note } = {}) {
    await this.request("POST", `/v2/invoicing/invoices/${id}/remind`, { subject, note, send_to_recipient: true });
    const s = await this.getInvoice(id);
    ledger.record({ type: "reminder_sent", ref: id, label: `Reminder for ${s.number} to ${s.recipient_email}`, amount: s.amount, currency: s.currency });
    return { reminded: true, invoice: s };
  }

  async cancelInvoice(id, { note } = {}) {
    await this.request("POST", `/v2/invoicing/invoices/${id}/cancel`, { note, send_to_recipient: true, send_to_invoicer: false });
    const s = await this.getInvoice(id);
    ledger.record({ type: "invoice_cancelled", ref: id, label: `${s.number} cancelled`, amount: s.amount, currency: s.currency });
    return s;
  }

  // ---- Orders v2 (payment links / checkout) ----
  async createOrder({ amount, currency = "USD", description }) {
    const order = await this.request("POST", "/v2/checkout/orders", {
      intent: "CAPTURE",
      purchase_units: [{ amount: { currency_code: currency, value: money(amount) }, description }],
      application_context: {
        brand_name: this.businessName,
        user_action: "PAY_NOW",
        shipping_preference: "NO_SHIPPING",
        return_url: `${this.publicUrl}/paypal/return`,
        cancel_url: `${this.publicUrl}/paypal/cancel`,
      },
    });
    const s = summarizeOrder(order);
    s.amount ??= money(amount);
    s.currency ??= currency;
    s.description ??= description;
    s.checkout_page = `${this.publicUrl}/pay/${order.id}`;
    ledger.record({ type: "payment_link_created", ref: order.id, label: `Payment link: ${description || "payment"}`, amount: s.amount, currency, link: s.checkout_page });
    return s;
  }

  async getOrder(id) {
    const s = summarizeOrder(await this.request("GET", `/v2/checkout/orders/${id}`));
    s.checkout_page = `${this.publicUrl}/pay/${id}`;
    return s;
  }

  async captureOrder(id) {
    const order = await this.request("POST", `/v2/checkout/orders/${id}/capture`, {}, { Prefer: "return=representation" });
    const s = summarizeOrder(order);
    ledger.record({
      type: "payment_captured",
      ref: id,
      capture_id: s.capture_id,
      label: `${s.description || "Payment"} from ${s.payer_email || "buyer"}`,
      amount: s.amount,
      currency: s.currency,
    });
    return s;
  }

  // ---- Payments v2 ----
  async refundCapture(capture_id, { amount, currency = "USD", note_to_payer } = {}) {
    const body = { note_to_payer };
    if (amount !== undefined && amount !== null) body.amount = { value: money(amount), currency_code: currency };
    const r = await this.request("POST", `/v2/payments/captures/${capture_id}/refund`, body, { Prefer: "return=representation" });
    const out = { id: r.id, status: r.status, amount: r.amount?.value, currency: r.amount?.currency_code, capture_id };
    ledger.record({ type: "refund", ref: r.id, capture_id, label: `Refund on capture ${capture_id}`, amount: out.amount, currency: out.currency });
    return out;
  }

  // ---- Transaction Search (reporting) ----
  async searchTransactions({ days = 30 } = {}) {
    const end = new Date();
    const start = new Date(end.getTime() - Math.min(days, 31) * 86400_000);
    const qs = new URLSearchParams({
      start_date: paypalDate(start),
      end_date: paypalDate(end),
      fields: "transaction_info,payer_info",
      page_size: "100",
    });
    const data = await this.request("GET", `/v1/reporting/transactions?${qs}`);
    return {
      note: "PayPal's reporting API can lag up to ~3 hours behind real time in sandbox.",
      count: data.transaction_details?.length || 0,
      transactions: (data.transaction_details || []).map((t) => ({
        id: t.transaction_info?.transaction_id,
        event_code: t.transaction_info?.transaction_event_code,
        status: t.transaction_info?.transaction_status,
        amount: t.transaction_info?.transaction_amount?.value,
        currency: t.transaction_info?.transaction_amount?.currency_code,
        fee: t.transaction_info?.fee_amount?.value,
        date: t.transaction_info?.transaction_initiation_date,
        payer_email: t.payer_info?.email_address,
        note: t.transaction_info?.transaction_note || t.transaction_info?.transaction_subject,
      })),
    };
  }
}

// ---------------------------------------------------------------------------
// Mock client: same interface, no network. Lets anyone try the agent instantly.
// ---------------------------------------------------------------------------
class MockPayPalClient {
  constructor({ publicUrl, businessName }) {
    this.mode = "mock";
    this.clientId = null;
    this.publicUrl = publicUrl;
    this.businessName = businessName;
    this.invoices = new Map();
    this.orders = new Map();
    this.seq = 1000;
  }

  id(prefix) {
    return `${prefix}-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
  }

  async createInvoice({ recipient_email, recipient_name, items, currency = "USD", note, payment_term = "NET_30" }) {
    const total = items.reduce((a, i) => a + Number(i.unit_amount) * Number(i.quantity ?? 1), 0);
    const inv = {
      id: this.id("INV2-MOCK"),
      status: "DRAFT",
      detail: { invoice_number: `MOCK-${++this.seq}`, currency_code: currency, note, payment_term: { term_type: payment_term }, invoice_date: new Date().toISOString().slice(0, 10), metadata: {} },
      primary_recipients: [{ billing_info: { email_address: recipient_email, name: splitName(recipient_name) } }],
      items: items.map((i) => ({ name: i.name, quantity: String(i.quantity ?? 1), unit_amount: { value: money(i.unit_amount) } })),
      amount: { value: money(total), currency_code: currency },
      due_amount: { value: money(total) },
    };
    this.invoices.set(inv.id, inv);
    const s = summarizeInvoice(inv);
    ledger.record({ type: "invoice_created", ref: s.id, label: `${s.number} draft for ${recipient_email}`, amount: s.amount, currency });
    return s;
  }

  inv(id) {
    const inv = this.invoices.get(id);
    if (!inv) throw new Error(`Invoice ${id} not found (mock mode)`);
    return inv;
  }

  async sendInvoice(id) {
    const inv = this.inv(id);
    if (inv.status !== "DRAFT") throw new Error(`Invoice ${id} is ${inv.status}, only DRAFT invoices can be sent`);
    inv.status = "SENT";
    inv.detail.metadata.recipient_view_url = `${this.publicUrl}/mock/invoice/${id}`;
    const s = summarizeInvoice(inv);
    ledger.record({ type: "invoice_sent", ref: id, label: `${s.number} sent to ${s.recipient_email}`, amount: s.amount, currency: s.currency, link: s.payer_view_url });
    return s;
  }

  async getInvoice(id) {
    return summarizeInvoice(this.inv(id));
  }

  async listInvoices({ status } = {}) {
    const all = [...this.invoices.values()].filter((i) => !status || i.status === status).reverse();
    return { total: all.length, invoices: all.map(summarizeInvoice) };
  }

  async remindInvoice(id) {
    const s = summarizeInvoice(this.inv(id));
    ledger.record({ type: "reminder_sent", ref: id, label: `Reminder for ${s.number} to ${s.recipient_email}`, amount: s.amount, currency: s.currency });
    return { reminded: true, invoice: s };
  }

  async cancelInvoice(id) {
    const inv = this.inv(id);
    inv.status = "CANCELLED";
    const s = summarizeInvoice(inv);
    ledger.record({ type: "invoice_cancelled", ref: id, label: `${s.number} cancelled`, amount: s.amount, currency: s.currency });
    return s;
  }

  async markInvoicePaid(id) {
    const inv = this.inv(id);
    inv.status = "PAID";
    inv.due_amount = { value: "0.00" };
    const s = summarizeInvoice(inv);
    ledger.record({ type: "invoice_paid", ref: id, label: `${s.number} paid by ${s.recipient_email}`, amount: s.amount, currency: s.currency });
    return s;
  }

  async createOrder({ amount, currency = "USD", description }) {
    const order = {
      id: this.id("MOCKORDER"),
      status: "CREATED",
      purchase_units: [{ amount: { value: money(amount), currency_code: currency }, description, payments: {} }],
      links: [],
    };
    this.orders.set(order.id, order);
    const s = summarizeOrder(order);
    s.checkout_page = `${this.publicUrl}/pay/${order.id}`;
    ledger.record({ type: "payment_link_created", ref: order.id, label: `Payment link: ${description || "payment"}`, amount: s.amount, currency, link: s.checkout_page });
    return s;
  }

  ord(id) {
    const o = this.orders.get(id);
    if (!o) throw new Error(`Order ${id} not found (mock mode)`);
    return o;
  }

  async getOrder(id) {
    const s = summarizeOrder(this.ord(id));
    s.checkout_page = `${this.publicUrl}/pay/${id}`;
    return s;
  }

  async captureOrder(id) {
    const o = this.ord(id);
    if (o.status === "COMPLETED") throw new Error("Order already captured");
    o.status = "COMPLETED";
    o.payer = { email_address: "sandbox-buyer@example.com", name: { given_name: "Sandbox", surname: "Buyer" } };
    o.purchase_units[0].payments.captures = [{ id: this.id("MOCKCAPTURE"), status: "COMPLETED" }];
    const s = summarizeOrder(o);
    ledger.record({ type: "payment_captured", ref: id, capture_id: s.capture_id, label: `${s.description || "Payment"} from ${s.payer_email}`, amount: s.amount, currency: s.currency });
    return s;
  }

  async refundCapture(capture_id, { amount, currency = "USD" } = {}) {
    const order = [...this.orders.values()].find((o) => o.purchase_units[0].payments.captures?.[0]?.id === capture_id);
    if (!order) throw new Error(`Capture ${capture_id} not found (mock mode)`);
    const value = money(amount ?? order.purchase_units[0].amount.value);
    const refund = { id: this.id("MOCKREFUND"), status: "COMPLETED", amount: { value, currency_code: currency } };
    (order.purchase_units[0].payments.refunds ||= []).push(refund);
    ledger.record({ type: "refund", ref: refund.id, capture_id, label: `Refund on capture ${capture_id}`, amount: value, currency });
    return { id: refund.id, status: refund.status, amount: value, currency, capture_id };
  }

  async searchTransactions() {
    const tx = ledger.list({ limit: 200 }).filter((e) => ["payment_captured", "refund", "invoice_paid"].includes(e.type));
    return { note: "Mock mode: built from the local ledger.", count: tx.length, transactions: tx };
  }
}

export function createPayPal({ clientId, clientSecret, publicUrl, businessName }) {
  if (clientId && clientSecret) return new PayPalClient({ clientId, clientSecret, publicUrl, businessName });
  return new MockPayPalClient({ publicUrl, businessName });
}
