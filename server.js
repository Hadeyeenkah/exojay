require("dotenv").config();
const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");

const app = express();
app.set("trust proxy", true); // needed on Render/Vercel/Nginx so req.ip is the real visitor IP
app.use(express.json({ limit: "10kb" }));

const origins = (process.env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim());
app.use(cors({ origin: origins.includes("*") ? true : origins }));

const COOLDOWN_MS = (Number(process.env.COOLDOWN_MINUTES) || 30) * 60 * 1000;
const seen = new Map(); // ip -> last alert time

const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|monitor|curl|wget/i;

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

// ---------- Route ----------
app.post("/api/visit", async (req, res) => {
  res.sendStatus(204); // answer immediately, never slow the visitor's page

  try {
    const ip = (req.ip || "").replace("::ffff:", "");
    const ua = req.get("user-agent") || "";
    if (BOT_RE.test(ua)) return;

    const now = Date.now();
    if (now - (seen.get(ip) || 0) < COOLDOWN_MS) return;
    seen.set(ip, now);

    const { page = "/", referrer = "", site = "" } = req.body || {};
    const location = await geo(ip);
    const device = /mobile|android|iphone/i.test(ua) ? "Mobile" : "Desktop";

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

app.get("/", (_req, res) => res.send("Visitor alerts running"));

// keep the memory map small
setInterval(() => {
  const cutoff = Date.now() - COOLDOWN_MS;
  for (const [ip, t] of seen) if (t < cutoff) seen.delete(ip);
}, 10 * 60 * 1000);

app.listen(process.env.PORT || 3000, () => console.log("Listening on", process.env.PORT || 3000));