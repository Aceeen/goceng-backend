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
