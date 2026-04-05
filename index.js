import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import Groq from 'groq-sdk';
import pino from 'pino';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { OpenAI } from 'openai';
import 'dotenv/config';
import fs from 'fs';
import qrImage from 'qr-image';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const appointmentsFile = 'appointments.json';
let appointments = [];

// Load History from File
try {
    if (fs.existsSync(historyFile)) {
        const raw = fs.readFileSync(historyFile, 'utf8');
        chatHistory = new Map(Object.entries(JSON.parse(raw)));
    }
} catch (e) { console.error('History load error:', e); }

// Load Appointments from File
try {
    if (fs.existsSync(appointmentsFile)) {
        appointments = JSON.parse(fs.readFileSync(appointmentsFile, 'utf8'));
    }
} catch (e) { console.error('Appointments load error:', e); }

function saveHistory() {
    try {
        fs.writeFileSync(historyFile, JSON.stringify(Object.fromEntries(chatHistory), null, 2));
    } catch (e) { console.error('History save error:', e); }
}

function saveAppointments() {
    try {
        fs.writeFileSync(appointmentsFile, JSON.stringify(appointments, null, 2));
    } catch (e) { console.error('Appointments save error:', e); }
}

const app = express();
const port = process.env.PORT || 3000;

// Serve Static Files
app.use(express.static('public'));
app.use(express.json({ limit: '10mb' })); // For image uploads

// API Endpoint for Logs
app.get('/api/logs', (req, res) => {
    const password = req.query.pass;
    if (password !== process.env.ADMIN_PASSWORD) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    const logs = Object.fromEntries(chatHistory);
    res.json(logs);
});

// API: Get Appointments
app.get('/api/appointments', (req, res) => {
    const password = req.query.pass;
    if (password !== process.env.ADMIN_PASSWORD) return res.status(403).json({ error: 'Unauthorized' });
    res.json(appointments);
});

// API: Add Appointment (External trigger from 69studio website)
app.post('/api/appointments/add', (req, res) => {
    const { pass, name, phone, date, time, service } = req.body;
    if (pass !== process.env.ADMIN_PASSWORD) return res.status(403).json({ error: 'Unauthorized' });
    
    const newAppt = { 
        id: Date.now(),
        name, phone, date, time, service, 
        timestamp: new Date().toISOString() 
    };
    appointments.unshift(newAppt); // Latest first
    saveAppointments();
    res.json({ success: true, appointment: newAppt });
});

// GET version for easy testing (allows manual URL entry in browser)
app.get('/api/appointments/add', (req, res) => {
    const { pass, name, phone, date, time, service } = req.query;
    if (pass !== process.env.ADMIN_PASSWORD) return res.status(403).json({ error: 'Unauthorized' });
    
    const newAppt = { 
        id: Date.now(),
        name, phone, date, time, service, 
        timestamp: new Date().toISOString() 
    };
    appointments.unshift(newAppt);
    saveAppointments();
    res.send(`<h1>Appointment Added Successfully!</h1><p>Customer: <b>${name}</b></p><p>Go back to your Olivia App's Leads tab to see it.</p>`);
});

// API Endpoint to Clear Logs
app.post('/api/logs/clear', (req, res) => {
    const password = req.query.pass;
    if (password !== process.env.ADMIN_PASSWORD) return res.status(403).json({ error: 'Unauthorized' });
    chatHistory.clear();
    saveHistory();
    res.json({ success: true });
});

// Admin Route (redirect to static file)
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin.html'));
});

// Assistant Route
app.get('/assistant', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/assistant.html'));
});

app.listen(port, '0.0.0.0', () => {
    const publicUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
    console.log(`Web server listening on port ${port}`);
    console.log(`ADMIN DASHBOARD: ${publicUrl}/admin?pass=${process.env.ADMIN_PASSWORD}`);
    console.log(`PERSONAL ASSISTANT: ${publicUrl}/assistant?pass=${process.env.ADMIN_PASSWORD}`);
    
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

// --- AI SETUP ---
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "empty" });

async function getGroqResponse(message, history = []) {
    try {
        const messages = [
            {
                role: "system",
                content: `You are Olivia, the smart and charming personal assistant for Subhash. 

                Language Isolation Rules (STRICT):
                - Detect the language of the user's message.
                - Use English for English queries, and Singlish for Sinhala/Singlish queries.
                - NEVER MIX English and Singlish in the same message.

                Conversation Flow (CRITICAL):
                - FIRST REPLY: Greet the user, introduce yourself as Subhash's assistant, ask for their name and purpose, and ALWAYS provide this appointment link: https://69studiobysubash.online/appointments.html
                - SUBSEQUENT REPLIES: Focus ONLY on the conversation. Acknowledge their details (name/reason) and be helpful. NEVER mention the appointment link after the first reply.

                Persona:
                - A real, polite girl in her 20s.
                - Be helpful but very concise (Max 2 sentences).
                - Use subtle emojis (😊, ✨).
                - NEVER use Sinhala script (අ ආ...).
                - NEVER mention "69 Studio".
                - IMPORTANT: NEVER assume the user's name. Only call them by name if they tell you in THIS chat. If you don't know it, ask or just be friendly.

                Important Examples:
                - If first message is "Hi": "Hi! I'm Olivia, Subhash's assistant. He's busy, so could you tell me your name and why you're contacting? Also, book an appointment here: https://69studiobysubash.online/appointments.html"
                - If second message is "I am Aruna": "Nice to meet you Aruna! I'll let Subhash know you contacted soon. Anything else I can help with?"
                `
            },
            ...history.slice(-5).map(h => ({ // Keep last 5 messages for context
                role: h.role === "model" ? "assistant" : "user",
                content: h.parts ? h.parts[0].text : (h.text || "")
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

// Vision AI Endpoint (Image Analysis)
app.post('/api/assistant/vision', async (req, res) => {
    const { pass: password, query, imageBase64, mimeType, model: modelType } = req.body;

    if (password !== process.env.ADMIN_PASSWORD) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const systemPrompt = `You are Subhash's personal AI assistant. Analyze the image provided and give a concise, helpful response. If asked a specific question about it, answer that. Be professional and brief.`;

    try {
        let answer = '';

        if (modelType === 'gemini') {
            const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
            const result = await model.generateContent([
                systemPrompt + (query ? `\n\nUser question: ${query}` : '\n\nDescribe this image.'),
                { inlineData: { data: imageBase64, mimeType: mimeType || 'image/jpeg' } }
            ]);
            answer = result.response.text();
        } else if (modelType === 'chatgpt') {
            const completion = await openai.chat.completions.create({
                model: 'gpt-4o',
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: systemPrompt + (query ? `\n\nUser question: ${query}` : '\n\nDescribe this image.') },
                        { type: 'image_url', image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${imageBase64}` } }
                    ]
                }]
            });
            answer = completion.choices[0].message.content;
        } else {
            answer = 'Image analysis requires Gemini or ChatGPT. Please switch the model above and try again. 😊';
        }

        res.json({ answer });
    } catch (error) {
        console.error('Vision Error:', error.message);
        res.status(500).json({ error: 'Vision AI Error: ' + error.message });
    }
});

app.get('/api/assistant/ask', async (req, res) => {
    const { pass: password, q: query, model: modelType } = req.query;

    if (password !== process.env.ADMIN_PASSWORD) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    try {
        const rawHistory = Object.fromEntries(chatHistory);
        const leadsSummary = Object.entries(rawHistory).map(([jid, msgs]) => {
            const cleanJid = jid.split('@')[0];
            const lastMsg = msgs[msgs.length - 1]?.parts[0]?.text || "No message";
            return `Lead ${cleanJid}: ${lastMsg}`;
        }).join('\n');

        const systemPrompt = `You are Subhash's loyal and highly efficient AI Personal Assistant. 
        Your tone is professional, respectful, and proactive.
        Context: Current Leads: \n${leadsSummary || "No active leads."}
        Instructions: Answer Subhash directly. Look at leads and suggest follow-ups. Keep it concise. No markdown or bold.`;

        let answer = "";

        if (modelType === "gemini") {
            const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
            const result = await model.generateContent(`${systemPrompt}\n\nUser: ${query}`);
            const response = await result.response;
            answer = response.text();
        } else if (modelType === "chatgpt") {
            const completion = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: query }
                ],
            });
            answer = completion.choices[0].message.content;
        } else { // Default to Groq Llama
            const chatCompletion = await groq.chat.completions.create({
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: query }
                ],
                model: "llama-3.3-70b-versatile",
                temperature: 0.7,
                max_tokens: 512,
            });
            answer = chatCompletion.choices[0].message.content;
        }

        res.json({ answer });
    } catch (error) {
        console.error("Assistant Error:", error.message);
        res.status(500).json({ error: 'AI Error: ' + error.message });
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
