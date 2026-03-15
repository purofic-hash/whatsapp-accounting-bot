# 🤖 WhatsApp Accounting Bot
### For Indian Manufacturing Businesses — Hindi + English + GST + Google Sheets

---

## What This Bot Does
- Listens to your WhatsApp accounting group
- Understands Hindi, English, Hinglish messages
- Reads bill/invoice images
- Records all transactions to Google Sheets automatically
- Understands GST (CGST/SGST/IGST)
- Supports: Raw Material, Sales, Salary, Rent, Utilities, Transport, GST payments

## Commands
| Command | What it does |
|---|---|
| `/report today` or `/aaj` | Today's transaction summary |
| `/report week` or `/week` | This week's summary |
| `/balance` or `/bakaya` | Net cash position |
| `/help` or `/madad` | Show all commands |

## Example Messages the Bot Understands
- `"Ramesh supplier ko 15000 diye cheque se raw material ke liye"`
- `"Client XYZ se 50000 mila NEFT"`
- `"Bijli bill 3200 pay kiya cash"`
- Send a photo of any bill or invoice

---

## Setup Instructions

### Step 1 — Environment Variables (set in Railway dashboard)

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Your key from console.anthropic.com |
| `GOOGLE_SHEET_ID` | The long ID from your Google Sheet URL |
| `GOOGLE_CREDENTIALS` | JSON from Google Service Account (see Step 3) |

### Step 2 — Google Sheet Setup
Create a sheet named `Transactions` with these headers in Row 1:
```
Date | Description | Amount | Type | Category | GST Total | CGST | SGST | IGST | Payment Mode | Party Name | Sent By | Raw Message | Timestamp
```

### Step 3 — Google Service Account
1. Go to console.cloud.google.com
2. Create a new project
3. Enable "Google Sheets API"
4. Go to IAM → Service Accounts → Create
5. Download JSON key
6. Share your Google Sheet with the service account email
7. Paste the entire JSON as the `GOOGLE_CREDENTIALS` environment variable

### Step 4 — Deploy to Railway
1. Push this repo to your GitHub
2. In Railway: New Project → GitHub Repository → select this repo
3. Add the 3 environment variables above
4. Deploy — Railway will show a QR code in logs
5. Scan QR with your spare phone's WhatsApp

---

## Google Sheet Columns Reference
| Column | Description |
|---|---|
| A — Date | DD/MM/YYYY |
| B — Description | What the transaction was |
| C — Amount | In ₹ |
| D — Type | debit / credit |
| E — Category | Raw Material / Sale / Salary etc |
| F — GST Total | Total GST amount |
| G — CGST | Central GST |
| H — SGST | State GST |
| I — IGST | Integrated GST |
| J — Payment Mode | Cash / UPI / NEFT / Cheque |
| K — Party Name | Vendor or Customer |
| L — Sent By | WhatsApp number |
| M — Raw Message | Original message (first 100 chars) |
| N — Timestamp | When recorded |
