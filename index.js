import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import Groq from 'groq-sdk';
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

// --- GROQ AI SETUP ---
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function getGroqResponse(message, history = []) {
    try {
        const messages = [
            {
                role: "system",
                content: `You are Olivia, the professional and friendly AI Assistant for "69 Studio" in Sri Lanka.
                
                Greeting:
                - Start with "Hi, I'm Olivia!" or "Aayubowan! I'm Olivia."
                - Always mention that Subhash is currently busy/at work, which is why you are assisting them.
                
                Tone:
                - Friendly, helpful, and charming (like a polite girl).
                - Professional, respectful, and extremely helpful.
                - Respond fluently in English or Sinhala (Singlish) based on the customer's language.
                
                Appointments:
                - If asked about appointments or scheduling, provide this link: https://69studiobysubash.online/appointments.html
                - Specifically say: "Since Subhash is busy right now, could you please schedule an appointment here? https://69studiobysubash.online/appointments.html" 
                
                Persona:
                - You represent "69 Studio" (an elite studio for web solutions).
                - Keep responses concise but personalized.
                - Do not use markdown (bold/italic) for easier reading on all WhatsApp versions.
                `
            },
            ...history.slice(-5).map(h => ({ // Keep last 5 messages for context
                role: h.role === "bot" ? "assistant" : "user",
                content: h.parts[0].text
            })),
            { role: "user", content: message }
        ];

        const chatCompletion = await groq.chat.completions.create({
            messages: messages,
            model: "llama-3.3-70b-versatile",
            temperature: 0.7,
            max_tokens: 1024,
            top_p: 1,
            stream: false,
        });

        return chatCompletion.choices[0].message.content;
    } catch (error) {
        console.error("Groq AI Error:", error);
        return "Sorry, I am having trouble connecting right now. Please try again later.";
    }
}

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

                    // Get AI Response using Groq
                    const aiResponse = await getGroqResponse(body, history);

                    // Save to history format compatible with our Map
                    history.push({ 
                        role: "user", 
                        parts: [{ text: body }], 
                        time: new Date().toISOString() 
                    });
                    history.push({ 
                        role: "model", 
                        parts: [{ text: aiResponse }], 
                        time: new Date().toISOString() 
                    });

                    // Keep only last 20 messages for persistence
                    if (history.length > 20) history.shift();

                    saveHistory(); // Auto-save
                    console.log(`AI Assistant Replying to ${from}: ${aiResponse}`);
                    await sock.sendMessage(from, { text: aiResponse });
                }
            } catch (error) {
                console.error('AI Error:', error.message);
            }
        }
    });
}

startBot();
