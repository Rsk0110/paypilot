// PayPilot front-end: chat with the agent, approve gated actions, live activity feed.
const $ = (s) => document.querySelector(s);
const messagesEl = $("#messages");
const input = $("#input");
const sendBtn = $("#send");

let sessionId = localStorageGet("paypilot.session") || newSessionId();
let busy = false;

function localStorageGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function localStorageSet(k, v) {
  try { localStorage.setItem(k, v); } catch {}
}
function newSessionId() {
  const id = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2);
  localStorageSet("paypilot.session", id);
  return id;
}

// ---------- tiny, safe markdown renderer ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function inline(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>")
    .replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, "$1<i>$2</i>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
}
function markdown(src) {
  const lines = escapeHtml(src).split("\n");
  let html = "", list = null;
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const line of lines) {
    let m;
    if ((m = line.match(/^\s*[-*•]\s+(.*)/))) {
      if (list !== "ul") { close(); html += "<ul>"; list = "ul"; }
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
      if (list !== "ol") { close(); html += "<ol>"; list = "ol"; }
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^#{1,4}\s+(.*)/))) {
      close(); html += `<h4>${inline(m[1])}</h4>`;
    } else if (/^\s*\|/.test(line)) {
      close();
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
      const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => `<td>${inline(c.trim())}</td>`).join("");
      html += `<table class="md-table"><tr>${cells}</tr></table>`;
    } else if (line.trim() === "") {
      close(); html += "<div class='gap'></div>";
    } else {
      close(); html += `<p>${inline(line)}</p>`;
    }
  }
  close();
  return html.replace(/<\/table><table class="md-table">/g, "");
}

// ---------- rendering ----------
function scrollDown() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
function addMessage(role, text) {
  $(".welcome")?.remove();
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.innerHTML = role === "user" ? `<p>${escapeHtml(text)}</p>` : markdown(text);
  messagesEl.appendChild(div);
  scrollDown();
  return div;
}
function addTrace(trace) {
  if (!trace?.length) return;
  const wrap = document.createElement("div");
  wrap.className = "trace";
  for (const t of trace) {
    const d = document.createElement("details");
    d.className = `tool ${t.ok ? "ok" : "err"}`;
    d.innerHTML = `<summary><span class="dot"></span><code>${escapeHtml(t.tool)}</code> <span class="muted small">${t.ok ? `${t.ms} ms` : escapeHtml(t.error || "failed")}</span></summary>
      <pre>${escapeHtml(JSON.stringify({ input: t.input, [t.ok ? "result" : "error"]: t.ok ? t.result : t.error }, null, 2))}</pre>`;
    wrap.appendChild(d);
  }
  messagesEl.appendChild(wrap);
  scrollDown();
}
function addApproval(a) {
  const card = document.createElement("div");
  card.className = "approval";
  card.id = `ap-${a.id}`;
  card.innerHTML = `
    <div class="approval-head"><span class="lock">🔒</span> Approval needed - <code>${escapeHtml(a.tool)}</code></div>
    <p>${escapeHtml(a.summary)}</p>
    <details><summary class="small muted">Details</summary><pre>${escapeHtml(JSON.stringify(a.input, null, 2))}</pre></details>
    <div class="approval-actions">
      <button class="btn primary">Approve</button>
      <button class="btn ghost">Decline</button>
    </div>`;
  const [approve, decline] = card.querySelectorAll("button");
  const act = async (approved) => {
    if (busy) return;
    approve.disabled = decline.disabled = true;
    card.classList.add(approved ? "approved" : "declined");
    card.querySelector(".approval-actions").innerHTML = `<span class="small">${approved ? "✅ Approved" : "✖ Declined"}</span>`;
    await call("/api/approve", { sessionId, toolUseId: a.id, approved });
  };
  approve.onclick = () => act(true);
  decline.onclick = () => act(false);
  messagesEl.appendChild(card);
  scrollDown();
}
function thinking() {
  const div = document.createElement("div");
  div.className = "msg assistant typing";
  div.innerHTML = "<span></span><span></span><span></span>";
  messagesEl.appendChild(div);
  scrollDown();
  return div;
}

// ---------- API ----------
async function call(url, body) {
  busy = true;
  sendBtn.disabled = true;
  const t = thinking();
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    t.remove();
    if (!res.ok) throw new Error(data.error || res.statusText);
    addTrace(data.trace);
    if (data.reply) addMessage("assistant", data.reply);
    (data.approvals || []).filter((a) => !document.getElementById(`ap-${a.id}`)).forEach((a) => addApproval(a));
  } catch (err) {
    t.remove();
    addMessage("assistant error", `⚠️ ${err.message}`);
  } finally {
    busy = false;
    sendBtn.disabled = false;
    refreshLedger();
  }
}

async function send(text) {
  if (!text.trim() || busy) return;
  addMessage("user", text);
  input.value = "";
  autosize();
  await call("/api/chat", { sessionId, message: text });
  input.focus();
}

// ---------- activity ----------
const ICONS = {
  invoice_created: "📝", invoice_sent: "📨", invoice_paid: "💰", invoice_cancelled: "🚫",
  reminder_sent: "🔔", payment_link_created: "🔗", payment_captured: "💳", refund: "↩️",
};
const fmt = (n) => "$" + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

async function refreshLedger() {
  try {
    const { totals, events } = await (await fetch("/api/ledger")).json();
    $("#s-collected").textContent = fmt(totals.collected);
    $("#s-outstanding").textContent = fmt(totals.outstanding);
    $("#s-refunded").textContent = fmt(totals.refunded);
    $("#s-net").textContent = fmt(totals.net);
    const ul = $("#activity");
    if (!events.length) return;
    ul.innerHTML = events
      .map((e) => `<li>
        <span class="ico">${ICONS[e.type] || "•"}</span>
        <div><div>${e.link ? `<a href="${escapeHtml(e.link)}" target="_blank" rel="noopener">${escapeHtml(e.label)}</a>` : escapeHtml(e.label)}</div>
        <div class="muted small">${new Date(e.at).toLocaleString()}${e.capture_id ? ` · capture ${escapeHtml(e.capture_id)}` : ""}</div></div>
        <b class="amt ${e.type === "refund" ? "neg" : ""}">${e.amount ? (e.type === "refund" ? "-" : "") + fmt(e.amount) : ""}</b>
      </li>`)
      .join("");
  } catch {}
}

// ---------- wiring ----------
function autosize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
}
input.addEventListener("input", autosize);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send(input.value);
  }
});
$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  send(input.value);
});
document.querySelectorAll(".chip").forEach((c) => (c.onclick = () => send(c.textContent)));
$("#reset").onclick = async () => {
  await fetch("/api/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId }) });
  sessionId = newSessionId();
  location.reload();
};

(async () => {
  const cfg = await (await fetch("/api/config")).json();
  $("#biz").textContent = cfg.businessName;
  const mode = $("#mode");
  mode.textContent = cfg.mode === "mock" ? "Mock mode" : "PayPal sandbox";
  mode.className = `badge ${cfg.mode}`;
  const warn = [];
  if (!cfg.claudeReady) warn.push("ANTHROPIC_API_KEY is not set - the agent can't respond until you add it to .env and restart.");
  if (cfg.mode === "mock") warn.push("Running in mock mode: PayPal calls are simulated. Add PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET to use the real sandbox.");
  if (warn.length) {
    const w = $("#warning");
    w.innerHTML = warn.map(escapeHtml).join("<br>");
    w.hidden = false;
  }
  refreshLedger();
  setInterval(refreshLedger, 8000);
})();
