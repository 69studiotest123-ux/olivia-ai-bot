# 🤖 Olivia AI - Official WhatsApp Bot for 69 Studio

Welcome to the official 24/7 AI Digital Assistant for **69 Studio by Subhash Ketagoda**. This bot is designed to handle customer inquiries, capture leads, and manage appointment bookings seamlessly using Google's Gemini Pro AI.

---

## ✨ Features

*   **🧠 Intelligent Interaction:** Driven by Google Gemini 1.5 Flash for natural, context-aware conversations.
*   **🗣️ Multilingual Support:** Responds fluently in English, Sinhala, and Singlish.
*   **📅 Lead Capture:** Automatically guides users to the 69 Studio appointment system and collects contact info.
*   **💻 Command Dashboard:** Premium Admin Command Center to view live chat histories and track high-value leads.
*   **🛡️ Secure & Private:** Self-managed session handling and secret key protection.
*   **🚀 Render-Ready:** Built-in self-ping logic to maintain 24/7 uptime on Render's free tier.

---

## 🛠️ Setup Instructions

### 1. Configure Environment
Create a `.env` file in the root directory and add:
```env
GEMINI_API_KEY=your_google_gemini_api_key
ADMIN_PASSWORD=your_admin_dashboard_password
PORT=3000
RENDER_EXTERNAL_URL=https://your-app-name.onrender.com (Optional)
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Start the Intelligence
```bash
npm start
```
Scan the generated QR code in your terminal with your WhatsApp account (Link a New Device).

---

## ☁️ Deployment (Render.com)

1.  **Push to GitHub:** Commit all logic files (excluding secret folders like `auth_info_baileys`).
2.  **Create Web Service:** Connect your repo to Render.
3.  **Build Command:** `npm install`
4.  **Start Command:** `npm start`
5.  **Environment Variables:** Add your `.env` keys in Render's "Environment" tab.

---

## 👤 Admin Access
View live intelligence logs by navigating to:
`https://your-app-name.onrender.com/admin?pass=your_admin_password`

---

### 🎨 Developed by 69 Studio
*Modern Digital Excellence. Made in Sri Lanka.*