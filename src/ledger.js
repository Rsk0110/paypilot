// A small local activity ledger: every money-related action PayPilot takes is
// recorded here so the agent (and the dashboard) can look things up quickly,
// e.g. find the capture ID to refund. Persisted to data/ledger.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const FILE = path.join(DATA_DIR, "ledger.json");

let events = [];
try {
  events = JSON.parse(fs.readFileSync(FILE, "utf8"));
} catch {
  events = [];
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(events, null, 2));
  } catch (err) {
    console.warn("Could not persist ledger:", err.message);
  }
}

export function record(event) {
  const entry = { at: new Date().toISOString(), ...event };
  events.unshift(entry);
  events = events.slice(0, 500);
  save();
  return entry;
}

export function list({ limit = 50, type } = {}) {
  return events.filter((e) => !type || e.type === type).slice(0, limit);
}

export function summary() {
  const sum = (type) =>
    events.filter((e) => e.type === type).reduce((acc, e) => acc + Number(e.amount || 0), 0);
  const sentInvoices = events.filter((e) => e.type === "invoice_sent");
  const cancelled = new Set(events.filter((e) => e.type === "invoice_cancelled").map((e) => e.ref));
  const paidInvoices = new Set(events.filter((e) => e.type === "invoice_paid").map((e) => e.ref));
  const outstanding = sentInvoices
    .filter((e) => !cancelled.has(e.ref) && !paidInvoices.has(e.ref))
    .reduce((acc, e) => acc + Number(e.amount || 0), 0);
  const collected = sum("payment_captured") + sum("invoice_paid");
  const refunded = sum("refund");
  return {
    collected: round(collected),
    refunded: round(refunded),
    net: round(collected - refunded),
    outstanding: round(outstanding),
    invoices_sent: sentInvoices.length,
    payments: events.filter((e) => e.type === "payment_captured").length,
  };
}

function round(n) {
  return Math.round(n * 100) / 100;
}
