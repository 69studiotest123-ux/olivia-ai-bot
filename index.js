import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers } from '@whiskeysockets/baileys';
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

const chatHistory = new Map();
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
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

async function startBot() {
    const version = [2, 3000, 1036512893];
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

                   const prompt = `You are a professional AI Assistant for Subhash from 69 Studio. 
                   Subhash is currently WORKING.
                   
                   IMPORTANT INSTRUCTIONS:
                   1. IF THIS IS THE VERY FIRST REPLY: Inform the user that Subhash is currently working and available for appointments. 
                      MUST provide this link: https://69studiobysubash.online/
                   2. IF YOU HAVE ALREADY GIVEN THE APPOINTMENT LINK: Continue the conversation naturally. Ask for their Name, Contact Number, and the reason they are contacting Subhash so he can review it later.
                   3. Respond in the SAME language as the sender (Sinhala or English).
                   
                   Current Chat History: ${JSON.stringify(history)}
                   New Message from customer: "${body}"
                   
                   Reply naturally and politely. Just output the response text.`;
                   
                   const result = await model.generateContent(prompt);
                   const response = await result.response;
                   const text = response.text();

                   history.push({ role: "user", text: body });
                   history.push({ role: "model", text: text });
                   if (history.length > 20) history.shift();

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
