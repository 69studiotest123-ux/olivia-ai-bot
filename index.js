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
import { google } from 'googleapis';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const historyFile = 'history.json';
const appointmentsFile = 'appointments.json';
const todosFile = 'todos.json';
let chatHistory = new Map();
let appointments = [];
let todos = [];

// --- Server-Sent Events (SSE) for Real-Time UI ---
let streamClients = [];
function notifyClients() {
    streamClients.forEach(client => {
        try { client.write('data: update\n\n'); } catch (e) {}
    });
}

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
        notifyClients();
    } catch (e) { console.error('History save error:', e); }
}

function saveAppointments() {
    try {
        fs.writeFileSync(appointmentsFile, JSON.stringify(appointments, null, 2));
        notifyClients();
    } catch (e) { console.error('Appointments save error:', e); }
}

// Load Todos from File
try {
    if (fs.existsSync(todosFile)) {
        todos = JSON.parse(fs.readFileSync(todosFile, 'utf8'));
    }
} catch (e) { console.error('Todos load error:', e); }

function saveTodos() {
    try {
        fs.writeFileSync(todosFile, JSON.stringify(todos, null, 2));
        notifyClients();
    } catch (e) { console.error('Todos save error:', e); }
}

const app = express();
const port = process.env.PORT || 3000;

// --- ROBUST CORS CONFIGURATION ---
app.use((req, res, next) => {
    const origin = req.headers.origin;
    // Explicitly allow your common domains and any other for safety
    res.header('Access-Control-Allow-Origin', origin || '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept');
    res.header('Access-Control-Allow-Credentials', 'true');
    
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json({ limit: '10mb' }));

// --- API ROUTES FIRST (To prevent static file hijacking) ---

// Server-Sent Events Endpoint
app.get('/api/stream', (req, res) => {
    const password = req.query.pass;
    if (password !== process.env.ADMIN_PASSWORD) return res.status(403).json({ error: 'Unauthorized' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Critical for Render/Nginx streaming
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.flushHeaders();

    // Send initial keep-alive comment
    res.write(': ok\n\n');

    streamClients.push(res);
    req.on('close', () => { streamClients = streamClients.filter(c => c !== res); });
});

// API Endpoint for Logs
app.get('/api/logs', (req, res) => {
    const password = req.query.pass;
    if (password !== process.env.ADMIN_PASSWORD) return res.status(403).json({ error: 'Unauthorized' });
    res.json(Object.fromEntries(chatHistory));
});

// API: Get Appointments
app.get('/api/appointments', (req, res) => {
    const password = req.query.pass;
    if (password !== process.env.ADMIN_PASSWORD) return res.status(403).json({ error: 'Unauthorized' });
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(appointments));
});

// API: Get Todos
app.get('/api/todos', (req, res) => {
    const password = req.query.pass;
    if (password !== process.env.ADMIN_PASSWORD) return res.status(403).json({ error: 'Unauthorized' });
    res.json(todos);
});

const tokensFile = 'push-tokens.json';
let pushTokens = [];

// Load Push Tokens from File
try {
    if (fs.existsSync(tokensFile)) {
        pushTokens = JSON.parse(fs.readFileSync(tokensFile, 'utf8'));
    }
} catch (e) { console.error('Push tokens load error:', e); }

function savePushTokens() {
    try {
        fs.writeFileSync(tokensFile, JSON.stringify(pushTokens, null, 2));
    } catch (e) { console.error('Push tokens save error:', e); }
}

// API: Save Push Token
app.post('/api/save-token', (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token is required' });
    
    if (!pushTokens.includes(token)) {
        pushTokens.push(token);
        savePushTokens();
    }
    res.json({ success: true });
});

// API: Manage Todos (Add, Toggle, Delete)
app.post('/api/todos', (req, res) => {
    const { pass, action, text, id, url } = req.body;
    if (pass !== process.env.ADMIN_PASSWORD) return res.status(403).json({ error: 'Unauthorized' });

    if (action === 'add') {
        const newTodo = { id: Date.now(), text, completed: false, url: url || '' };
        todos.unshift(newTodo);
    } else if (action === 'toggle') {
        const t = todos.find(t => t.id === id);
        if (t) t.completed = !t.completed;
    } else if (action === 'delete') {
        todos = todos.filter(t => t.id !== id);
    }
    saveTodos();
    res.json({ success: true, todos });
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
    
    // Auto-sync with Google Calendar (Async background task)
    addToGoogleCalendar(newAppt).catch(e => console.error('Calendar task failed:', e.message));
    
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

    // Auto-sync with Google Calendar
    addToGoogleCalendar(newAppt).catch(e => console.error('Calendar task failed:', e.message));

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

// --- GOOGLE CALENDAR LOGIC ---
async function addToGoogleCalendar(appt) {
    if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
        console.warn('⚠️ Google Calendar credentials missing in .env. Skipping sync.');
        return;
    }

    try {
        let privateKey = process.env.GOOGLE_PRIVATE_KEY;
        if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
            privateKey = privateKey.substring(1, privateKey.length - 1);
        }
        privateKey = privateKey.replace(/\\n/g, '\n');

        const auth = new google.auth.JWT({
            email: process.env.GOOGLE_CLIENT_EMAIL,
            key: privateKey,
            scopes: ['https://www.googleapis.com/auth/calendar']
        });

        const calendar = google.calendar({ version: 'v3', auth });
        const calendarId = process.env.GOOGLE_CALENDAR_ID || process.env.GOOGLE_CLIENT_EMAIL;

        // Parse date/time — assuming Sinhala user enters like 2024-05-10 and 10:00AM
        // A smarter parser would be needed for complex formats
        const startDateTime = new Date(`${appt.date} ${appt.time}`);
        const endDateTime = new Date(startDateTime.getTime() + 60 * 60 * 1000); // 1hr duration default

        const event = {
            summary: `📅 Olivia: Appointment with ${appt.name}`,
            location: '69 Studio',
            description: `Customer Phone: ${appt.phone}\nService: ${appt.service || 'Photography'}\n\nBooked via Olivia AI Assistant.`,
            start: { dateTime: startDateTime.toISOString(), timeZone: 'Asia/Colombo' },
            end: { dateTime: endDateTime.toISOString(), timeZone: 'Asia/Colombo' },
            reminders: { useDefault: true }
        };

        await calendar.events.insert({ calendarId, resource: event });
        console.log(`✅ Event successfully added to Google Calendar for ${appt.name}`);
    } catch (error) {
        console.error('❌ Failed to add event to Google Calendar:', error.message);
    }
}

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

// --- AI SETUP AND PARSERS ---
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "empty" });

function processAiResponseForTodos(aiText) {
    if (!aiText) return aiText;
    const todoRegex = /\[ADD_TODO:\s*(.+?)\]/gi;
    let match;
    let added = false;
    while ((match = todoRegex.exec(aiText)) !== null) {
        todos.unshift({ id: Date.now() + Math.random(), text: match[1].trim(), completed: false, url: '' });
        added = true;
    }
    if (added) saveTodos();
    return aiText.replace(todoRegex, '').trim();
}

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
                
                Tool Integration:
                - If you need to remind Subhash to do something, or the user asks to add a todo list task, add this EXACT tag in your message: [ADD_TODO: task description].
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

// Website Chat Endpoint (Connects your website widget to Olivia)
app.post('/api/chat', async (req, res) => {
    const { message, user } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });

    try {
        // Use a default user ID for website guests if no session ID provided
        const userId = user || 'website-guest';
        
        if (!chatHistory.has(userId)) chatHistory.set(userId, []);
        const history = chatHistory.get(userId);

        // Process via Groq
        let aiResponse = await getGroqResponse(message, history);
        aiResponse = processAiResponseForTodos(aiResponse);

        // Keep history for conversational flow
        history.push({
            role: "user",
            parts: [{ text: message }],
            time: new Date().toISOString()
        });
        history.push({
            role: "model",
            parts: [{ text: aiResponse }],
            time: new Date().toISOString()
        });
        if (history.length > 20) history.shift();
        saveHistory();

        res.json({ reply: aiResponse });
    } catch (error) {
        console.error("Web Chat API Error:", error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

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

        const systemPrompt = `You are Subhash's loyal and highly efficient AI Personal Assistant named Olivia. 
        Your tone is friendly and concise. You understand both English and Sinhala/Singlish.
        CRITICAL INSTRUCTIONS: 
        1. Answer the user directly based on their prompt.
        2. KEEP IT VERY CONCISE (1-2 sentences maximum). Do not use bold or markdown.
        3. Only mention the following recent leads *if* the user explicitly asks about leads or updates:
        ${leadsSummary ? leadsSummary.substring(0, 500) : "No active leads."}
        
        TOOL INTEGRATION:
        - If Subhash asks you to remind him of a task, or add a task to his to-do list, add this EXACT tag in your message: [ADD_TODO: task description].
        Example: "I've added that to your list! [ADD_TODO: Read email]"
        `;

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

        answer = processAiResponseForTodos(answer);
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
                    let aiResponse = await getGroqResponse(body, history);
                    aiResponse = processAiResponseForTodos(aiResponse);

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
