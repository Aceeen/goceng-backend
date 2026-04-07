# GOCENG Backend

GOCENG is a smart personal finance application that bridges a WhatsApp Assistant with a web dashboard for financial orchestration. This repository handles the core webhook logic, Google Sheets/Drive API interactions, and Supabase security flows.

## ⚡ Prerequisites
Make sure you have the following installed locally:
- **Node.js** (v20+ LTS recommended)
- **Git**

---

## 🛠️ Team Local Setup Guide

Since our team uses a **Shared Supabase Database** and shared Google/WhatsApp API keys, you do not need to create your own database. Follow these steps to get your local server running seamlessly:

### 1. Install Dependencies
Navigate into this backend folder and install the required NPM packages.
```bash
npm install
```

### 2. Configure the Shared Environment File
Ask the lead engineer for the **Master `.env` file**. 
1. Place the provided `.env` file inside the root of this `goceng-backend` folder.
2. Under no circumstances should you commit this file to git or share it publicly!

### 3. Generate Database Types (Prisma)
Because we are connecting to a shared database, **do not run `migrate dev` or `db seed`**, as those commands modify the database structure and initial data for the entire team! 

Instead, just download the latest table schemas to your local Node.js typings by pulling the client:
```bash
npx.cmd prisma generate
```

### 4. Start the Server
Start your local development server (with hot-reload via nodemon).
```bash
npm run dev
```
The server will boot up and default to `http://localhost:3001` so it doesn't clash with your frontend React environment running on port 3000!

---

## 🧪 Testing Webhooks Locally
If you need to test the WhatsApp Webhooks live from Meta on your local machine:

1. Keep your GOCENG backend server running (`npm run dev`).
2. Open a new terminal and expose your local port securely with ngrok:
   ```bash
   ngrok http 3001
   ```
3. Copy the secure HTTPS URL provided by ngrok (e.g., `https://[id].ngrok-free.app`).
4. Update the Meta WhatsApp dashboard's Webhook URL placeholder temporarily to your ngrok URL appended with `/v1/webhook`.
5. *(Remember to change it back to the staging/production domain when you are done testing!)*

---

## 📚 Scripts Reference
- `npm run dev` - Starts the Nodemon development server
- `npm run build` - Compiles TypeScript down to standard JS
- `npm run generate` - Regenerates your Prisma Types locally (Run this whenever someone else pushes a schema change!)

## Modules
1. Categories & Accounts Modules
Added GET /v1/categories returning all generic categories natively sorted for rendering dropdown menus cleanly.
Added full mapping for Accounts (CRUD operations). Accounts update automatically when transactions are saved to keep the user's balances dynamically synchronized!
2. Transactions Module (/v1/transactions)
GET logic: Fully features pagination limits, dates, and category filtering dynamically built onto Prisma where clauses.
Transactional integrity: The POST and DELETE requests run under $transaction locks so that an account's currentBalance perfectly reflects any added or removed ledger entries.
3. Budgets Module (/v1/budgets)
Uses Prisma's parallel aggregation queries to calculate the limitAmount alongside the literal realized spending extracted mathematically straight from the matching month's transactions.
Calculates your percentages and throws out automated statuses (ON_TRACK, WARNING, OVER_BUDGET).
4. Dashboards Aggregation (/v1/dashboard/summary)
The mecca of the frontend application. It crunches massive arrays to return precisely what the technical PDF asked for in a single request:

totalBalance computed from all Active bank accounts.
monthlyIncome and monthlyExpense.
Returns an aggregated array spendingByCategory with pre-computed percentages for your Pie Charts.
Groups expenses efficiently into cashFlowByWeek arrays.
5. PDF Reporting APIs (/v1/reports/data)
Produces a uniquely crafted payload that groups all expenses, logs, metadata, and status snapshots into an isolated JSON payload specific to a given ?month=X&year=Y query. This is optimized for pushing into jsPDF renderers.