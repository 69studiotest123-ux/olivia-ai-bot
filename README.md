# 🤖 WhatsApp AI Auto-Reply Bot

An intelligent, lightweight, and modern WhatsApp AI Bot built with [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) and Google Gemini (with Groq fallback).

---

## 🚀 Features
- ⚡ **Lightweight & Fast**: Pure WhatsApp bot without heavy web servers or bloatware.
- 📱 **Terminal QR Scan**: Login easily by scanning the QR code printed directly in your terminal.
- 🧠 **Google Gemini 2.0 Flash**: Fast, high-quality responses in English, Sinhala (සිංහල), or Singlish.
- 🔄 **Groq Fallback**: Optional fallback to LLaMA 3.3 70B via Groq.
- 💾 **Session Persistence**: Auth credentials stored in `auth_info_baileys/` so you only scan once.
- ✍️ **Typing Indicator**: Shows "typing..." in WhatsApp while thinking of a response.
- 🔁 **Auto-Reconnect**: Seamlessly reconnects if your internet disconnects.

---

## 🛠️ Quick Start Guide

### 1. Install Dependencies
Run in terminal:
```bash
npm install
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env`:
```bash
copy .env.example .env
```
Open `.env` and add your **Gemini API Key**:
```env
GEMINI_API_KEY=AIzaSy...your_gemini_key_here
```
> 💡 *You can get a free Gemini API key from [Google AI Studio](https://aistudio.google.com).*

### 3. Start the Bot
```bash
npm start
```
1. A QR code will display in your terminal.
2. Open WhatsApp on your phone:
   - Tap **Settings** (or 3 dots on Android) > **Linked Devices** > **Link a Device**.
3. Scan the terminal QR code.
4. Your bot is now live! Any message sent to this WhatsApp account will receive an AI reply.

---

## ⚙️ Configuration Options (.env)
| Key | Description | Default |
|-----|-------------|---------|
| `GEMINI_API_KEY` | Google Gemini API Key | Required for Gemini |
| `GROQ_API_KEY` | Groq API Key (Optional) | Required for Groq |
| `AI_PROVIDER` | AI Engine (`gemini` or `groq`) | `gemini` |
| `BOT_NAME` | Name of the AI assistant | `Olivia AI` |
| `AUTO_REPLY` | Enable/Disable AI auto reply (`true` or `false`) | `true` |
| `SYSTEM_PROMPT` | Custom prompt/persona for the bot | Helpful AI Assistant |
