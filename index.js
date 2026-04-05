import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import { GoogleGenerativeAI } from '@google/generative-ai';
import pino from 'pino';
import 'dotenv/config';
import fs from 'fs';
import qrImage from 'qr-image';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const historyFile = 'history.json';
let chatHistory = new Map();

// Load History from File
try {
    if (fs.existsSync(historyFile)) {
        const raw = fs.readFileSync(historyFile, 'utf8');
        const parsed = JSON.parse(raw);
        chatHistory = new Map(Object.entries(parsed));
        console.log('✅ Loaded persistent chat history.');
    }
} catch (e) {
    console.error('❌ Failed to load history:', e.message);
}

function saveHistory() {
    try {
        const data = Object.fromEntries(chatHistory);
        fs.writeFileSync(historyFile, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('❌ Failed to save history:', e.message);
    }
}

const app = express();
const port = process.env.PORT || 3000;

// Serve Static Files
app.use(express.static('public'));

// API Endpoint for Logs
app.get('/api/logs', (req, res) => {
    const password = req.query.pass;
    if (password !== process.env.ADMIN_PASSWORD) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    const logs = Object.fromEntries(chatHistory);
    res.json(logs);
});

// API Endpoint to Clear Logs
app.post('/api/logs/clear', (req, res) => {
    const password = req.query.pass;
    if (password !== process.env.ADMIN_PASSWORD) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    chatHistory.clear();
    saveHistory();
    res.json({ success: true });
});

// Admin Route (redirect to static file)
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin.html'));
});

app.listen(port, '0.0.0.0', () => {
    const publicUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
    console.log(`Web server listening on port ${port}`);
    console.log(`ADMIN DASHBOARD: ${publicUrl}/admin?pass=${process.env.ADMIN_PASSWORD}`);
    
    // --- SELF PING TO KEEP ALIVE ON RENDER ---
    if (process.env.RENDER_EXTERNAL_URL) {
        setInterval(async () => {
            try {
                await fetch(process.env.RENDER_EXTERNAL_URL);
                console.log('Self-ping successful: Bot is awake.');
            } catch (e) {
                console.error('Self-ping failed:', e.message);
            }
        }, 10 * 60 * 1000); // Ping every 10 minutes
    }
});

// --- GOOGLE AI SETUP ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ 
    model: "gemini-1.5-flash", // Reverted to standard stable model
    generationConfig: {
        maxOutputTokens: 500,
        temperature: 0.7,
    }
});

async function startBot() {
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`📡 Connecting with WhatsApp v${version.join('.')} (Latest: ${isLatest})`);
    
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: false
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('--- SCAN THE QR CODE BELOW WITH WHATSAPP ---');
            qrcode.generate(qr, { small: true });
            const qr_svg = qrImage.image(qr, { type: 'png' });
            qr_svg.pipe(fs.createWriteStream('qr.png'));
        }

        if (connection === 'close') {
            const shouldReconnect = (new Boom(lastDisconnect?.error)).output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('--- BOT IS READY! YOUR AI IS NOW ACTIVE ---');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        const body = (msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption);

        if (body) {
            console.log(`Received message from ${from}: ${body}`);
            try {
                if (from.endsWith('@s.whatsapp.net') || from.endsWith('@lid')) {
                   if (!chatHistory.has(from)) chatHistory.set(from, []);
                   const history = chatHistory.get(from);

                    const prompt = `You are "Olivia", the official AI Digital Assistant for 69 Studio by Subhash Ketagoda.
                   Subhash is currently focused on high-end project development and cannot take calls immediately.
                   
                   BUSINESS CONTEXT:
                   - 69 Studio is a premium digital agency specializing in High-Performance Web Development, UI/UX Design, and Branding.
                   - Subhash Ketagoda is the Founder & Lead Developer.
                   
                   CONVERSATION FLOW:
                   1. IF NEW CHAT: Warmly welcome them. Briefly state Subhash is busy but YOU (Olivia) are here. 
                      MANDATORY: Provide the Appointment Link: https://69studiobysubash.online/
                   2. GOAL: If they didn't book an appointment yet, politely ask for their:
                      - Full Name
                      - Business Interest (Web, Brand, App?)
                      - Phone Number
                   3. TONE: Professional, futuristic, elite, yet helpful.
                   4. LANGUAGE: Automatically detect and respond in the user's language (Sinhala, English, or Singlish).
                   
                   Current Chat Context: ${JSON.stringify(history)}
                   New Message from customer: "${body}"
                   
                   Keep responses concise and conversion-focused.`;
                   
                   const result = await model.generateContent(prompt);
                   const response = await result.response;
                   const text = response.text();

                   history.push({ role: "user", text: body, time: new Date().toISOString() });
                   history.push({ role: "model", text: text, time: new Date().toISOString() });
                   if (history.length > 20) history.shift();

                   saveHistory(); // Auto-save on every message
                   console.log(`AI Assistant Replying to ${from}: ${text}`);
                   await sock.sendMessage(from, { text: text });
                }
            } catch (error) {
                console.error('AI Error:', error.message);
            }
        }
    });
}

startBot();
