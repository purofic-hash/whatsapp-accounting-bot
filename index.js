const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_SHEET_ID   = process.env.GOOGLE_SHEET_ID;
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS; // JSON string

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─── WhatsApp Client ──────────────────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath: process.env.CHROMIUM_PATH ||
      require('child_process').execSync('which chromium || which chromium-browser || which google-chrome || echo ""').toString().trim() ||
      undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
    ],
    headless: true,
  }
});

client.on('qr', qr => {
  console.log('\n📱 Scan this QR code with your spare phone WhatsApp:\n');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('✅ WhatsApp bot is ready and listening!');
});

client.on('message', async (msg) => {
  try {
    // Ignore status broadcasts
    if (msg.from === 'status@broadcast') return;

    const chat = await msg.getChat();
    const senderName = msg.author ? msg.author.split('@')[0] : msg.from.split('@')[0];

    // ── Commands ──────────────────────────────────────────────────────────────
    if (msg.body.startsWith('/')) {
      await handleCommand(msg, chat);
      return;
    }

    // ── Voice Note ────────────────────────────────────────────────────────────
    if (msg.type === 'ptt' || msg.type === 'audio') {
      await msg.reply('🎙️ Voice note mila! Abhi voice transcription ke liye OpenAI Whisper setup karna hoga. Text mein bhejo filhaal.');
      return;
    }

    // ── Image / Document ──────────────────────────────────────────────────────
    if (msg.hasMedia && (msg.type === 'image' || msg.type === 'document')) {
      await msg.reply('🖼️ Bill/receipt mil gaya, process kar raha hoon...');
      const media = await msg.downloadMedia();
      await processImageTransaction(msg, media, senderName, chat);
      return;
    }

    // ── Text Message ──────────────────────────────────────────────────────────
    if (msg.body && msg.body.trim().length > 2) {
      await processTextTransaction(msg, senderName, chat);
    }

  } catch (err) {
    console.error('Message handling error:', err);
  }
});

// ─── Process Text Transaction ─────────────────────────────────────────────────
async function processTextTransaction(msg, senderName, chat) {
  const result = await extractTransaction(msg.body, 'text', null);

  if (result.type === 'not_a_transaction') return; // Ignore normal chat

  if (result.confidence === 'low') {
    await msg.reply(`🤔 Samajh nahi aaya poora. Kya aap confirm kar sakte ho?\n\n*Amount:* ₹${result.amount || '?'}\n*Type:* ${result.category || '?'}\n\nSahi ho toh reply mein "haan" bhejo.`);
    return;
  }

  await saveToSheet(result, msg.body, senderName);
  await msg.reply(formatConfirmation(result));
}

// ─── Process Image Transaction ────────────────────────────────────────────────
async function processImageTransaction(msg, media, senderName, chat) {
  const result = await extractTransaction(null, 'image', media.data);

  if (result.type === 'not_a_transaction') {
    await msg.reply('🖼️ Yeh image koi bill nahi lagti. Transaction image bhejo.');
    return;
  }

  await saveToSheet(result, 'Image/Bill uploaded', senderName);
  await msg.reply(formatConfirmation(result));
}

// ─── Claude AI: Extract Transaction ──────────────────────────────────────────
async function extractTransaction(text, type, imageBase64) {
  const systemPrompt = `You are an accounting assistant for an Indian manufacturing business.
Extract transaction details from text or bill images.
The business does: raw material purchases, production expenses, sales of finished goods, salary payments, utility bills, GST filings, transport/logistics.

Return ONLY valid JSON, no markdown, no explanation:
{
  "date": "DD/MM/YYYY",
  "description": "short description in English",
  "amount": 0000,
  "type": "debit or credit",
  "category": "one of: Raw Material / Finished Goods Sale / Salary / Rent / Utilities / Transport / GST Payment / Bank Transfer / Other",
  "gst_amount": 000,
  "cgst": 000,
  "sgst": 000,
  "igst": 000,
  "payment_mode": "Cash / UPI / NEFT / Cheque / Bank Transfer",
  "party_name": "vendor or customer name if mentioned",
  "confidence": "high or low"
}

If NOT a transaction, return: {"type":"not_a_transaction"}
Input may be Hindi, English, or Hinglish. Default GST 18% split equally as CGST+SGST unless IGST mentioned.`;

  const messages = [];

  if (type === 'image' && imageBase64) {
    messages.push({
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: 'Extract transaction from this bill/receipt image.' }
      ]
    });
  } else {
    messages.push({ role: 'user', content: `Extract transaction from: "${text}"` });
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 500,
      system: systemPrompt,
      messages
    });

    const raw = response.content[0].text.replace(/```json|```/g, '').trim();
    return JSON.parse(raw);
  } catch (e) {
    console.error('Claude error:', e);
    return { type: 'not_a_transaction' };
  }
}

// ─── Commands Handler ─────────────────────────────────────────────────────────
async function handleCommand(msg, chat) {
  const cmd = msg.body.toLowerCase().trim();

  if (cmd === '/report today' || cmd === '/aaj') {
    const data = await getSheetData();
    const today = new Date().toLocaleDateString('en-IN');
    const todayRows = data.filter(r => r[0] === today);
    await msg.reply(generateReport(todayRows, 'Aaj ka Report'));

  } else if (cmd === '/report week' || cmd === '/week') {
    const data = await getSheetData();
    const weekRows = getThisWeekRows(data);
    await msg.reply(generateReport(weekRows, 'Is Hafte ka Report'));

  } else if (cmd === '/balance' || cmd === '/bakaya') {
    const data = await getSheetData();
    const balance = calculateBalance(data);
    await msg.reply(`💰 *Current Cash Position*\n\nTotal Credit (In): ₹${balance.credit}\nTotal Debit (Out): ₹${balance.debit}\n*Net Balance: ₹${balance.net}*`);

  } else if (cmd === '/help' || cmd === '/madad') {
    await msg.reply(`🤖 *Accounting Bot Commands*\n\n📊 /report today — Aaj ki summary\n📊 /report week — Is hafte ki summary\n💰 /balance — Net cash position\n\n*Transaction bhejne ka tarika:*\n• "Ramesh ko 5000 diye UPI se"\n• "Client ABC se 25000 mila"\n• Bill/invoice ki photo bhejo\n\nBot Hindi, English, dono samjhta hai! 🇮🇳`);
  }
}

// ─── Google Sheets ────────────────────────────────────────────────────────────
async function getSheetsClient() {
  const creds = JSON.parse(GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
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
    console.log('✅ Saved to sheet:', data.description);
  } catch (e) {
    console.error('Sheets error:', e.message);
  }
}

async function getSheetData() {
  try {
    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: 'Transactions!A2:N',
    });
    return res.data.values || [];
  } catch (e) {
    console.error('Sheets read error:', e.message);
    return [];
  }
}

// ─── Report Helpers ───────────────────────────────────────────────────────────
function generateReport(rows, title) {
  if (!rows.length) return `📊 *${title}*\n\nKoi transaction nahi mili.`;

  let credit = 0, debit = 0, gst = 0;
  const lines = rows.map(r => {
    const amt = parseFloat(r[2]) || 0;
    if (r[3] === 'credit') credit += amt; else debit += amt;
    gst += parseFloat(r[5]) || 0;
    return `• ${r[1]} — ₹${amt} (${r[3] === 'credit' ? '📈' : '📉'})`;
  });

  return `📊 *${title}*\n\n${lines.join('\n')}\n\n` +
    `────────────────\n` +
    `📈 Total In: ₹${credit}\n` +
    `📉 Total Out: ₹${debit}\n` +
    `🧾 Total GST: ₹${gst}\n` +
    `*Net: ₹${credit - debit}*`;
}

function calculateBalance(rows) {
  let credit = 0, debit = 0;
  rows.forEach(r => {
    const amt = parseFloat(r[2]) || 0;
    if (r[3] === 'credit') credit += amt; else debit += amt;
  });
  return { credit, debit, net: credit - debit };
}

function getThisWeekRows(rows) {
  const now = new Date();
  const weekStart = new Date(now.setDate(now.getDate() - now.getDay()));
  return rows.filter(r => {
    const parts = (r[0] || '').split('/');
    if (parts.length !== 3) return false;
    const d = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
    return d >= weekStart;
  });
}

function formatConfirmation(result) {
  const emoji = result.type === 'credit' ? '📈' : '📉';
  return `✅ *Transaction Record Ho Gayi!*\n\n` +
    `${emoji} *${result.description}*\n` +
    `💰 Amount: ₹${result.amount}\n` +
    `📂 Category: ${result.category}\n` +
    `💳 Payment: ${result.payment_mode}\n` +
    (result.party_name ? `👤 Party: ${result.party_name}\n` : '') +
    (result.gst_amount > 0 ? `🧾 GST: ₹${result.gst_amount} (CGST: ₹${result.cgst} + SGST: ₹${result.sgst})\n` : '') +
    `📅 Date: ${result.date}`;
}

// ─── Start ────────────────────────────────────────────────────────────────────
client.initialize();
