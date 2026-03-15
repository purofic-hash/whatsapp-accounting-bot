const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const QRCode = require('qrcode');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_SHEET_ID   = process.env.GOOGLE_SHEET_ID;
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS;
const PORT = process.env.PORT || 3000;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─── QR Code Web Server ───────────────────────────────────────────────────────
let currentQR = null;

const server = http.createServer(async (req, res) => {
  if (req.url === '/') {
    if (!currentQR) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><head><meta http-equiv="refresh" content="3"><style>body{background:#111;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;}</style></head><body><h2>⏳ Waiting for QR Code...</h2><p>Page will refresh automatically</p></body></html>`);
      return;
    }
    try {
      const qrImage = await QRCode.toDataURL(currentQR, { width: 400, margin: 2 });
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><head><style>body{background:#111;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:20px;}img{border:8px solid white;border-radius:12px;}</style></head><body>
        <h2>📱 Scan with WhatsApp</h2>
        <img src="${qrImage}" />
        <p>Open WhatsApp → Linked Devices → Link a Device → Scan</p>
        <p style="color:#aaa;font-size:12px">QR expires in 60s — refresh page if needed</p>
      </body></html>`);
    } catch(e) {
      res.writeHead(500); res.end('QR Error');
    }
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

server.listen(PORT, () => console.log(`🌐 QR page running on port ${PORT}`));

// ─── WhatsApp Bot ─────────────────────────────────────────────────────────────
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    browser: ['Accounting Bot', 'Chrome', '1.0.0'],
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      console.log('\n📱 QR Code ready! Open your Railway public URL to scan it.\n');
    }

    if (connection === 'close') {
      currentQR = null;
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
        : true;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) setTimeout(startBot, 3000);
    }

    if (connection === 'open') {
      currentQR = null;
      console.log('✅ WhatsApp connected! Bot is live.');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const from = msg.key.remoteJid;
      const senderName = msg.pushName || from.split('@')[0];

      // Get message text
      const text = msg.message?.conversation ||
                   msg.message?.extendedTextMessage?.text ||
                   msg.message?.imageMessage?.caption || '';

      // Commands
      if (text.startsWith('/')) {
        await handleCommand(sock, from, text);
        continue;
      }

      // Image
      if (msg.message?.imageMessage) {
        await sock.sendMessage(from, { text: '🖼️ Bill/receipt mil gaya, process kar raha hoon...' });
        await processTextTransaction(sock, from, text || 'image received', senderName);
        continue;
      }

      // Text transaction
      if (text && text.trim().length > 3) {
        await processTextTransaction(sock, from, text, senderName);
      }
    }
  });
}

// ─── Process Transaction ──────────────────────────────────────────────────────
async function processTextTransaction(sock, from, text, senderName) {
  const result = await extractTransaction(text);
  if (result.type === 'not_a_transaction') return;

  if (result.confidence === 'low') {
    await sock.sendMessage(from, { text: `🤔 Thoda unclear hai. Kya yeh sahi hai?\n\n*Amount:* ₹${result.amount || '?'}\n*Category:* ${result.category || '?'}\n\nConfirm karne ke liye dobara bhejo.` });
    return;
  }

  await saveToSheet(result, text, senderName);
  await sock.sendMessage(from, { text: formatConfirmation(result) });
}

// ─── Claude AI ────────────────────────────────────────────────────────────────
async function extractTransaction(text) {
  const systemPrompt = `You are an accounting assistant for an Indian manufacturing business.
Extract transaction details from text. Input may be Hindi, English, or Hinglish.
The business does: raw material purchases, production, sales, salary, rent, utilities, transport, GST.

Return ONLY valid JSON, no markdown:
{
  "date": "DD/MM/YYYY",
  "description": "short description in English",
  "amount": 0000,
  "type": "debit or credit",
  "category": "Raw Material / Finished Goods Sale / Salary / Rent / Utilities / Transport / GST Payment / Bank Transfer / Other",
  "gst_amount": 000,
  "cgst": 000,
  "sgst": 000,
  "igst": 000,
  "payment_mode": "Cash / UPI / NEFT / Cheque / Bank Transfer",
  "party_name": "vendor or customer name if mentioned",
  "confidence": "high or low"
}
If NOT a transaction, return: {"type":"not_a_transaction"}
Default GST 18%, split as CGST+SGST unless IGST mentioned.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Extract transaction: "${text}"` }]
    });
    const raw = response.content[0].text.replace(/```json|```/g, '').trim();
    return JSON.parse(raw);
  } catch (e) {
    console.error('Claude error:', e.message);
    return { type: 'not_a_transaction' };
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────
async function handleCommand(sock, from, cmd) {
  cmd = cmd.toLowerCase().trim();

  if (cmd === '/report today' || cmd === '/aaj') {
    const data = await getSheetData();
    const today = new Date().toLocaleDateString('en-IN');
    const rows = data.filter(r => r[0] === today);
    await sock.sendMessage(from, { text: generateReport(rows, 'Aaj ka Report') });

  } else if (cmd === '/balance' || cmd === '/bakaya') {
    const data = await getSheetData();
    const b = calculateBalance(data);
    await sock.sendMessage(from, { text: `💰 *Cash Position*\n\n📈 Total In: ₹${b.credit}\n📉 Total Out: ₹${b.debit}\n*Net: ₹${b.net}*` });

  } else if (cmd === '/help' || cmd === '/madad') {
    await sock.sendMessage(from, { text: `🤖 *Accounting Bot*\n\n/report today — Aaj ki summary\n/balance — Net position\n/help — Yeh message\n\nKoi bhi transaction Hindi ya English mein bhejo, main record kar lunga! 🇮🇳` });
  }
}

// ─── Google Sheets ────────────────────────────────────────────────────────────
async function getSheetsClient() {
  const creds = JSON.parse(GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return google.sheets({ version: 'v4', auth });
}

async function saveToSheet(data, rawMessage, senderName) {
  try {
    const sheets = await getSheetsClient();
    const row = [
      data.date || new Date().toLocaleDateString('en-IN'),
      data.description || '',
      data.amount || 0,
      data.type || '',
      data.category || '',
      data.gst_amount || 0,
      data.cgst || 0,
      data.sgst || 0,
      data.igst || 0,
      data.payment_mode || '',
      data.party_name || '',
      senderName,
      rawMessage.substring(0, 100),
      new Date().toISOString(),
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: 'Transactions!A:N',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });
    console.log('✅ Saved:', data.description);
  } catch (e) {
    console.error('Sheets error:', e.message);
  }
}

async function getSheetData() {
  try {
    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range: 'Transactions!A2:N' });
    return res.data.values || [];
  } catch (e) { return []; }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateReport(rows, title) {
  if (!rows.length) return `📊 *${title}*\n\nKoi transaction nahi.`;
  let credit = 0, debit = 0;
  const lines = rows.map(r => {
    const amt = parseFloat(r[2]) || 0;
    if (r[3] === 'credit') credit += amt; else debit += amt;
    return `• ${r[1]} — ₹${amt} ${r[3] === 'credit' ? '📈' : '📉'}`;
  });
  return `📊 *${title}*\n\n${lines.join('\n')}\n\n📈 In: ₹${credit}\n📉 Out: ₹${debit}\n*Net: ₹${credit - debit}*`;
}

function calculateBalance(rows) {
  let credit = 0, debit = 0;
  rows.forEach(r => { const a = parseFloat(r[2]) || 0; if (r[3] === 'credit') credit += a; else debit += a; });
  return { credit, debit, net: credit - debit };
}

function formatConfirmation(result) {
  const emoji = result.type === 'credit' ? '📈' : '📉';
  return `✅ *Recorded!*\n\n${emoji} ${result.description}\n💰 ₹${result.amount}\n📂 ${result.category}\n💳 ${result.payment_mode}` +
    (result.party_name ? `\n👤 ${result.party_name}` : '') +
    (result.gst_amount > 0 ? `\n🧾 GST: ₹${result.gst_amount}` : '') +
    `\n📅 ${result.date}`;
}

// ─── Start ────────────────────────────────────────────────────────────────────
startBot().catch(console.error);
