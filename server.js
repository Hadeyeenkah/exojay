require("dotenv").config();
const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");

const app = express();
app.set("trust proxy", true); // needed on Render/Vercel/Nginx so req.ip is the real visitor IP
app.use(express.json({ limit: "10kb" }));

const origins = (process.env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim());
app.use(cors({ origin: origins.includes("*") ? true : origins }));

const COOLDOWN_MS = (Number(process.env.COOLDOWN_MINUTES) || 30) * 60 * 1000;
const seen = new Map(); // ip -> last alert time

const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|monitor|curl|wget/i;

// ---------- Simple persisted log (JSON file) ----------
// Render's free disk is wiped on redeploy/restart, so this is "good enough" for a
// rolling dashboard, not permanent storage. Swap in a real DB later if you need history.
const DATA_FILE = path.join(__dirname, "visits.json");
const MAX_ENTRIES = 500;

function loadVisits() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return [];
  }
}
function saveVisit(entry) {
  const visits = loadVisits();
  visits.unshift(entry); // newest first
  if (visits.length > MAX_ENTRIES) visits.length = MAX_ENTRIES;
  fs.writeFileSync(DATA_FILE, JSON.stringify(visits, null, 2));
}

// ---------- Channels ----------
async function sendTelegram(text) {
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chat } = process.env;
  if (!token || !chat) return;
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error("Telegram: " + (await r.text()));
}

let mailer;
async function sendEmail(subject, text) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_TO } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !EMAIL_TO) return;
  mailer ||= nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 465,
    secure: (Number(SMTP_PORT) || 465) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  await mailer.sendMail({ from: SMTP_USER, to: EMAIL_TO, subject, text });
}

async function sendWhatsApp(text) {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_WHATSAPP_FROM: from, WHATSAPP_TO: to } = process.env;
  if (!sid || !token || !from || !to) return;
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ From: from, To: to, Body: text }),
  });
  if (!r.ok) throw new Error("WhatsApp: " + (await r.text()));
}

// ---------- Helpers ----------
async function geo(ip) {
  try {
    const r = await fetch(`https://ipwho.is/${ip}`);
    const d = await r.json();
    if (d.success) return `${d.city || "?"}, ${d.country || "?"}`;
  } catch {}
  return "Unknown";
}

// ---------- Visit route ----------
app.post("/api/visit", async (req, res) => {
  res.sendStatus(204); // answer immediately, never slow the visitor's page

  try {
    const ip = (req.ip || "").replace("::ffff:", "");
    const ua = req.get("user-agent") || "";
    if (BOT_RE.test(ua)) return;

    const { page = "/", referrer = "", site = "" } = req.body || {};
    const location = await geo(ip);
    const device = /mobile|android|iphone/i.test(ua) ? "Mobile" : "Desktop";
    const now = Date.now();

    // Always log to the dashboard, even within the alert cooldown window
    saveVisit({
      time: new Date(now).toISOString(),
      site,
      page,
      referrer: referrer || "Direct",
      location,
      device,
      ip,
    });

    if (now - (seen.get(ip) || 0) < COOLDOWN_MS) return;
    seen.set(ip, now);

    const text =
      `👀 New visitor${site ? " on " + site : ""}\n` +
      `Page: ${page}\n` +
      `From: ${referrer || "Direct"}\n` +
      `Location: ${location}\n` +
      `Device: ${device}\n` +
      `Time: ${new Date().toUTCString()}`;

    const results = await Promise.allSettled([
      sendTelegram(text),
      sendEmail("New visitor on your website", text),
      sendWhatsApp(text),
    ]);
    results.forEach((r) => r.status === "rejected" && console.error(r.reason.message));
  } catch (e) {
    console.error(e);
  }
});

// ---------- Dashboard ----------
app.get("/api/visits", (req, res) => {
  res.json(loadVisits());
});

app.get("/dashboard", (req, res) => {
  res.send(DASHBOARD_HTML);
});

app.get("/", (_req, res) => res.send(DASHBOARD_HTML));

// keep the memory map small
setInterval(() => {
  const cutoff = Date.now() - COOLDOWN_MS;
  for (const [ip, t] of seen) if (t < cutoff) seen.delete(ip);
}, 10 * 60 * 1000);

app.listen(process.env.PORT || 3000, () => console.log("Listening on", process.env.PORT || 3000));

const DASHBOARD_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Visitor Dashboard</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; background: #0b0d10; color: #e6e8eb; }
  h1 { font-size: 1.3rem; margin: 0 0 4px; }
  .sub { color: #9aa3ab; font-size: 0.85rem; margin-bottom: 20px; }
  .stats { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
  .card { background: #15181c; border: 1px solid #262a2f; border-radius: 10px; padding: 14px 18px; min-width: 120px; }
  .card .num { font-size: 1.6rem; font-weight: 600; }
  .card .label { font-size: 0.8rem; color: #9aa3ab; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #262a2f; white-space: nowrap; }
  th { color: #9aa3ab; font-weight: 500; position: sticky; top: 0; background: #0b0d10; }
  tr:hover { background: #15181c; }
  .wrap { overflow-x: auto; border: 1px solid #262a2f; border-radius: 10px; }
  .empty { padding: 40px; text-align: center; color: #9aa3ab; }
</style>
</head>
<body>
  <h1>Visitor Dashboard</h1>
  <div class="sub">Auto-refreshes every 15s · last <span id="count">0</span> visits</div>
  <div class="stats" id="stats"></div>
  <div class="wrap">
    <table>
      <thead>
        <tr><th>Time</th><th>Site</th><th>Page</th><th>Location</th><th>Device</th><th>Referrer</th></tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
    <div class="empty" id="empty" style="display:none">No visits logged yet.</div>
  </div>

<script>
async function load() {
  const res = await fetch('/api/visits');
  const visits = await res.json();
  document.getElementById('count').textContent = visits.length;
  document.getElementById('rows').innerHTML = visits.map(v => \`
    <tr>
      <td>\${new Date(v.time).toLocaleString()}</td>
      <td>\${v.site || '-'}</td>
      <td>\${v.page}</td>
      <td>\${v.location}</td>
      <td>\${v.device}</td>
      <td>\${v.referrer}</td>
    </tr>\`).join('');
  document.getElementById('empty').style.display = visits.length ? 'none' : 'block';

  const today = visits.filter(v => new Date(v.time).toDateString() === new Date().toDateString()).length;
  const uniqueIps = new Set(visits.map(v => v.ip)).size;
  document.getElementById('stats').innerHTML = \`
    <div class="card"><div class="num">\${visits.length}</div><div class="label">Total logged</div></div>
    <div class="card"><div class="num">\${today}</div><div class="label">Today</div></div>
    <div class="card"><div class="num">\${uniqueIps}</div><div class="label">Unique visitors</div></div>
  \`;
}
load();
setInterval(load, 15000);
</script>
</body>
</html>`;