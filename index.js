import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
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
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import cors from 'cors';
import multer from 'multer';

const upload = multer({ dest: 'uploads/' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const historyFile = path.join(__dirname, 'history.json');
const appointmentsFile = 'appointments.json';
const todosFile = 'todos.json';
const pwaHistoryFile = 'pwa_history.json';
const memoryFile = './memories.json';
const biometricFile = './biometrics.json';
const tokensFile = path.join(__dirname, 'push-tokens.json');
const settingsFile = path.join(__dirname, 'settings.json');
const prefsFile = 'preferences.json';
let chatHistory = new Map();
let appointments = [];
let todos = [];
let pushTokens = [];
let leads = [];
let preferences = {};
let biometricKeys = {};
let globalSettings = { 
    autoReply: true, 
    voiceMode: 'browser', // 'browser' or 'elevenlabs'
    voiceEnabled: true,
    personality: 'sophisticated', // 'sophisticated' or 'friendly'
    currentModel: 'groq',
    biometricEnabled: false,
    adminPassword: process.env.ADMIN_PASSWORD || '69studio123',
    OWNER_JID: '94761210164@s.whatsapp.net', // Sir Subhash's Number
    potions: {
        visionEye: true,
        deepMemory: true,
        homeHub: true
    }
};
const adminMuteMap = new Map(); // Tracks last manual reply time per JID

// Load Settings
if (fs.existsSync(settingsFile)) {
    try { 
        globalSettings = { ...globalSettings, ...JSON.parse(fs.readFileSync(settingsFile)) }; 
    } catch (e) {}
}

function saveSettings() {
    try { fs.writeFileSync(settingsFile, JSON.stringify(globalSettings, null, 2)); } catch (e) {}
}

// --- Server-Sent Events (SSE) for Real-Time UI ---
let streamClients = [];
let waConnectionStatus = 'disconnected'; // Current WhatsApp connection status

function notifyClients(type = 'update', data = null) {
    const payload = data ? JSON.stringify({ type, ...data }) : (typeof type === 'object' ? JSON.stringify(type) : type);
    streamClients.forEach(client => {
        try { client.write(`data: ${payload}\n\n`); } catch (e) {}
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
        console.log(`💾 History successfully saved to ${historyFile}`);
        notifyClients();
    } catch (e) { console.error('History save error:', e); }
}

function saveAppointments() {
    try {
        fs.writeFileSync(appointmentsFile, JSON.stringify(appointments, null, 2));
        console.log(`💾 Appointments saved to ${appointmentsFile}`);
        notifyClients('appointment'); // Specific type for appointments
    } catch (e) { console.error('Appointments save error:', e); }
}

function saveBiometricKeys() {
    try {
        fs.writeFileSync(biometricFile, JSON.stringify(biometricKeys, null, 2));
    } catch (e) { console.error('Biometric save error:', e); }
}

// Load Biometric Keys
try {
    if (fs.existsSync(biometricFile)) {
        biometricKeys = JSON.parse(fs.readFileSync(biometricFile, 'utf8'));
    }
} catch (e) { console.error('Biometric load error:', e); }


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

// --- PREFERENCE VAULT ---
if (fs.existsSync(prefsFile)) {
    try { preferences = JSON.parse(fs.readFileSync(prefsFile)); } catch (e) {}
}

const trendsFile = 'trends.json';
let trendsData = { cars: [], design: [], lastUpdate: null };
if (fs.existsSync(trendsFile)) {
    try { trendsData = JSON.parse(fs.readFileSync(trendsFile)); } catch (e) {}
}

function saveTrends() {
    try { fs.writeFileSync(trendsFile, JSON.stringify(trendsData, null, 2)); } catch (e) {}
}

function savePrefs() {
    try { fs.writeFileSync(prefsFile, JSON.stringify(preferences, null, 2)); } catch (e) {}
}

function loadBiometrics() {
    if (!fs.existsSync(biometricFile)) return {};
    try { return JSON.parse(fs.readFileSync(biometricFile)); }
    catch (e) { return {}; }
}

function saveBiometrics() {
    try { fs.writeFileSync(biometricFile, JSON.stringify(biometricKeys, null, 2)); } catch (e) {}
}

const biometricKeysRaw = loadBiometrics();
biometricKeys = biometricKeysRaw;

// --- AI CLIENT INITIALIZATION ---
let groq, genAI, openai;
try {
    if (process.env.GROQ_API_KEY) groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    if (process.env.GEMINI_API_KEY) genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    if (process.env.OPENAI_API_KEY) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    console.log('✅ AI Clients (Groq, Gemini, OpenAI) Initialized successfully.');
} catch (e) {
    console.error('❌ AI Initialization Error:', e.message);
}

// --- ELEVENLABS CLIENT ---
const xiClient = process.env.ELEVENLABS_API_KEY 
    ? new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY }) 
    : null;

const app = express();
const port = process.env.PORT || 3000;

// Update: Using professional cors package with expanded header support for PWA stability
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Cache-Control', 'Pragma', 'Expires']
}));

app.use(express.json({ limit: '10mb' }));

// --- HEALTH CHECK (RENDER BOOT STACK) ---
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'active', timestamp: new Date(), version: '8.3.1' });
});
app.use(express.static('public')); // Serve frontend files

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/index.html'));
});

// --- API ROUTES FIRST (To prevent static file hijacking) ---

// Server-Sent Events Endpoint
app.get('/api/stream', (req, res) => {
    if (!checkAuth(req.query.pass)) return res.status(403).json({ error: 'Unauthorized' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Accel-Buffering', 'no'); // Critical for Render/Nginx streaming
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Headers', 'Cache-Control, Pragma, Expires, Content-Type');
    res.flushHeaders();

    // Send initial keep-alive comment
    res.write(': ok\n\n');

    // Heartbeat to keep connection alive on Render (15s)
    const heartbeat = setInterval(() => {
        try {
            res.write('data: {"heartbeat":true}\n\n');
        } catch (e) {
            clearInterval(heartbeat);
        }
    }, 15000);

    streamClients.push(res);
    req.on('close', () => { 
        clearInterval(heartbeat);
        streamClients = streamClients.filter(c => c !== res); 
    });
});

// API: Get Logs (Enhanced with Mute Status)
app.get('/api/logs', (req, res) => {
    if (!checkAuth(req.query.pass)) return res.status(403).json({ error: 'Unauthorized' });
    
    const logs = Object.fromEntries(chatHistory);
    const muteStatus = {};
    
    // Include current mute timers for the PWA UI
    adminMuteMap.forEach((until, jid) => {
        if (until > Date.now()) {
            muteStatus[jid] = until;
        }
    });

    res.json({ logs, muteStatus });
});

// API: Resume AI (Force Manual Unmute)
app.post('/api/logs/resume', (req, res) => {
    const { pass, jid } = req.body;
    if (!checkAuth(pass)) return res.status(403).json({ error: 'Unauthorized' });
    if (!jid) return res.status(400).json({ error: 'JID is required' });

    adminMuteMap.delete(jid);
    console.log(`🚀 Manual Resume: Olivia is back for ${jid}`);
    notifyClients(); // Refresh PWA UI
    res.json({ success: true });
});

// API: Settings
app.get('/api/settings', (req, res) => {
    if (!checkAuth(req.query.pass)) return res.status(403).json({ error: 'Unauthorized' });
    res.json(globalSettings);
});

app.post('/api/settings', (req, res) => {
    if (!checkAuth(req.body.pass)) return res.status(403).json({ error: 'Unauthorized' });
    
    // Merge nested structures correctly
    if (req.body.settings.potions && typeof req.body.settings.potions === 'object') {
        globalSettings.potions = { ...globalSettings.potions, ...req.body.settings.potions };
        delete req.body.settings.potions;
    }
    
    globalSettings = { ...globalSettings, ...req.body.settings };
    saveSettings();
    console.log('⚙️ Settings updated:', globalSettings);
    res.json({ success: true, settings: globalSettings });
});

// API: Get Appointments
app.get('/api/appointments', (req, res) => {
    if (!checkAuth(req.query.pass)) return res.status(403).json({ error: 'Unauthorized' });
    res.json(appointments);
});

app.post('/api/appointments/confirm', async (req, res) => {
    const { pass, id } = req.body;
    if (!checkAuth(pass)) return res.status(403).json({ error: 'Unauthorized' });

    const appt = appointments.find(a => a.id == id);
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });

    appt.status = 'confirmed';
    saveAppointments();
    
    // Trigger Sync to Google Calendar
    await addToGoogleCalendar(appt);
    
    res.json({ success: true, appointment: appt });
});

app.post('/api/appointments/delete', (req, res) => {
    const { pass, id } = req.body;
    if (!checkAuth(pass)) return res.status(403).json({ error: 'Unauthorized' });

    appointments = appointments.filter(a => a.id != id);
    saveAppointments();
    res.json({ success: true });
});

// DEBUG: Raw History (Temporary for troubleshooting)
app.get('/api/debug/history', (req, res) => {
    res.json({
        totalChats: chatHistory.size,
        historyKeys: Array.from(chatHistory.keys()),
        raw: Object.fromEntries(chatHistory)
    });
});

// API: Get Bot Status
app.get('/api/status', (req, res) => {
    res.json({
        status: waConnectionStatus,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// (API: Get Appointments handled at line 270)

// API: Get Todos
app.get('/api/todos', (req, res) => {
    if (!checkAuth(req.query.pass)) return res.status(403).json({ error: 'Unauthorized' });
    res.json(todos);
});

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

// Authentication helper
const checkAuth = (pass) => {
    const masterPass = process.env.ADMIN_PASSWORD || '69studio123';
    return pass === masterPass;
};

async function sendPushToAll(title, body) {
    if (pushTokens.length === 0) {
        console.log('📡 No push tokens found. User needs to refresh the PWA to register.');
        return;
    }
    console.log(`📡 Attempting to send Push Notif to ${pushTokens.length} devices...`);

    if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
        console.warn('⚠️ Google credentials missing for Push Notif. Add them to .env.');
        return;
    }

    try {
        const privateKey = cleanKey(process.env.GOOGLE_PRIVATE_KEY);

        const auth = new google.auth.JWT({
            email: process.env.GOOGLE_CLIENT_EMAIL,
            key: privateKey,
            scopes: ['https://www.googleapis.com/auth/firebase.messaging']
        });

        // Get OAuth2 Access Token for HTTP v1 API
        const tokens = await auth.authorize();
        const accessToken = tokens.access_token;
        const projectId = process.env.FIREBASE_PROJECT_ID || "olivia-ai-7e3f5";

        for (const token of pushTokens) {
            try {
                const publicUrl = process.env.RENDER_EXTERNAL_URL || "https://olivia-ai-bot-1.onrender.com";
                const response = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${accessToken}`
                    },
                    body: JSON.stringify({
                        message: {
                            token: token,
                            notification: { 
                                title: `Olivia AI | ${title}`, 
                                body: body,
                                image: `${publicUrl}/olivia.png` // Large image for some systems
                            },
                            data: { 
                                title: `Olivia AI | ${title}`, 
                                body: body,
                                icon: `${publicUrl}/olivia.png`,
                                badge: `${publicUrl}/olivia.png`,
                                click_action: publicUrl
                            },
                            android: { 
                                priority: "high",
                                notification: {
                                    icon: "stock_ticker_update",
                                    color: "#ff4d4d",
                                    sound: "default",
                                    vibrate_timings: ["0.2s", "0.1s", "0.2s"]
                                }
                            },
                            apns: { 
                                payload: { 
                                    aps: { 
                                        sound: "default",
                                        badge: 1,
                                        "mutable-content": 1
                                    } 
                                } 
                            }
                        }
                    })
                });
                
                const data = await response.json();
                if (data.error) {
                    console.error('Push failed for token:', token, data.error.message);
                    if (data.error.message.includes('denied') || data.error.status === 'PERMISSION_DENIED') {
                        console.error('🔑 ACTION REQUIRED: Your service account is missing the "Firebase Cloud Messaging API (V1) Admin" role.');
                    }
                } else {
                    console.log('✅ Push sent successfully to:', token.substring(0, 10) + '...');
                }
            } catch (e) { 
                console.error('Network error during push for token:', token, e.message); 
            }
        }
    } catch (authError) {
        console.error('Failed to authenticate with Google for push notifications:', authError.message);
    }
}

// API: Save Push Token
app.post('/api/save-token', (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token is required' });
    
    if (!pushTokens.includes(token)) {
        pushTokens.push(token);
        savePushTokens();
        console.log('✅ New Push Token Registered:', token.substring(0, 10) + '...');
    }
    res.json({ success: true });
});

// API: Manage Todos (Add, Toggle, Delete)
app.post('/api/todos', (req, res) => {
    const { pass, action, text, id, url } = req.body;
    if (!checkAuth(pass)) return res.status(403).json({ error: 'Unauthorized' });

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
    console.log('📅 Incoming Booking Request:', req.body);
    const { pass, name, phone, date, time, service } = req.body;
    if (!checkAuth(pass)) return res.status(403).json({ error: 'Unauthorized' });

    const newAppt = {
        id: Date.now(),
        name, phone, date, time, service,
        timestamp: new Date().toISOString()
    };
    
    console.log('✅ Processing Booking for:', name);
    appointments.unshift(newAppt); // Latest first
    saveAppointments();
    
    // Send Push Notification
    sendPushToAll("New Studio Booking! 📅", `Booking from ${name} for ${service}`).catch(e => {});

    // Auto-sync with Google Calendar (Async background task)
    addToGoogleCalendar(newAppt).catch(e => console.error('Calendar task failed:', e.message));
    
    res.json({ success: true, appointment: newAppt });
});

// GET version for easy testing (allows manual URL entry in browser)
app.get('/api/appointments/add', (req, res) => {
    const { pass, name, phone, date, time, service } = req.query;
    if (!checkAuth(pass)) return res.status(403).json({ error: 'Unauthorized' });

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
    if (!checkAuth(req.query.pass)) return res.status(403).json({ error: 'Unauthorized' });
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

/**
 * GOOGLE CALENDAR HELPER
 */
async function getTodayEvents() {
    try {
        const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
        const privateKey = cleanKey(process.env.GOOGLE_PRIVATE_KEY);
        const calendarId = process.env.GOOGLE_CALENDAR_ID;

        if (!clientEmail || !privateKey || !calendarId) return [];

        const auth = new google.auth.JWT(clientEmail, null, privateKey, ['https://www.googleapis.com/auth/calendar.readonly']);
        const calendar = google.calendar({ version: 'v3', auth });
        
        const start = new Date();
        start.setHours(0,0,0,0);
        const end = new Date();
        end.setHours(23,59,59,999);

        const res = await calendar.events.list({
            calendarId: calendarId,
            timeMin: start.toISOString(),
            timeMax: end.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
        });

        return res.data.items.map(e => `${e.summary} (${new Date(e.start.dateTime || e.start.date).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})})`);
    } catch (e) {
        console.error('Calendar Fetch Error:', e.message);
        return [];
    }
}

/**
 * BUSY MODE DETECTION
 */
async function isSystemBusy() {
    const events = await getTodayEvents();
    const now = new Date();
    return events.some(e => {
        const timeStr = e.match(/\((.+?)\)/)?.[1];
        if (!timeStr) return false;
        // Simple logic: if an event started in the last 30 mins or starts in the next 30 mins, we are "busy"
        return false; // Stub: Real parsing would require more logic
    });
}

// --- GOOGLE CALENDAR LOGIC ---
async function addToGoogleCalendar(appt) {
    if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
        console.warn('⚠️ Google Calendar credentials missing in .env. Skipping sync.');
        return;
    }

    try {
        const privateKey = cleanKey(process.env.GOOGLE_PRIVATE_KEY);

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



// --- AI SETUP AND PARSERS ---

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

/**
 * Parses [BOOK_APPT: Name | Date | Time | Service]
 */
function processAiResponseForBookings(aiText, jid) {
    if (!aiText) return aiText;
    const bookRegex = /\[BOOK_APPT:\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\]/gi;
    let match;
    let addedCount = 0;

    while ((match = bookRegex.exec(aiText)) !== null) {
        const appt = {
            id: Date.now() + Math.random(),
            name: match[1].trim(),
            date: match[2].trim(),
            time: match[3].trim(),
            service: match[4].trim(),
            phone: jid.split('@')[0],
            status: globalSettings.autoConfirmBookings ? 'confirmed' : 'pending',
            jid: jid,
            createdAt: new Date().toISOString()
        };
        
        appointments.unshift(appt);
        addedCount++;

        // If auto-confirm is on, sync to Google Calendar immediately
        if (globalSettings.autoConfirmBookings) {
            addToGoogleCalendar(appt);
        }
    }

    if (addedCount > 0) {
        saveAppointments();
        notifyClients('appointment');
        
        // Trigger push notification for new booking
        const lastAppt = appointments[0];
        sendPushToAll("New Studio Booking! 📅", `Booking from ${lastAppt.name} for ${lastAppt.service}`).catch(e => {
            console.error('❌ Push Alert Failed for Booking:', e.message);
        });
    }

    return aiText.replace(bookRegex, '').trim();
}

/**
 * JARVIS Global Integration Tools
 */
async function getWeather(city) {
    const key = process.env.OPENWEATHER_API_KEY;
    if (!key) return "Weather system offline. Service key missing, Sir.";
    try {
        const res = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${key}&units=metric`);
        const data = await res.json();
        if (data.cod !== 200) return `Cannot localize weather for ${city}, Sir.`;
        return `Current weather in ${city}: ${data.weather[0].description}, Temp: ${data.main.temp}°C, Humidity: ${data.main.humidity}%`;
    } catch (e) { return "Weather downlink error, Sir."; }
}

async function getNews(topic = 'world') {
    const key = process.env.NEWS_API_KEY;
    if (!key) return "Global intel offline. API key missing, Sir.";
    try {
        const res = await fetch(`https://newsapi.org/v2/everything?q=${encodeURIComponent(topic)}&pageSize=3&apiKey=${key}`);
        const data = await res.json();
        if (!data.articles?.length) return `No recent intel found for ${topic}, Sir.`;
        return data.articles.map(a => `- ${a.title}`).join('\n');
    } catch (e) { return "Intel briefing error, Sir."; }
}

async function homeAssistantAction(entity, command) {
    const url = process.env.HOME_ASSISTANT_URL;
    const token = process.env.HOME_ASSISTANT_TOKEN;
    if (!url || !token) return "Home systems offline. Sync keys missing, Sir.";
    try {
        const domain = entity.split('.')[0];
        const res = await fetch(`${url}/api/services/${domain}/${command}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ entity_id: entity })
        });
        return res.ok ? `Command ${command} sent to ${entity}, Sir.` : "Execution failed on Home Core.";
    } catch (e) { return "Home link error, Sir."; }
}

async function triggerIFTTT(event, value) {
    const key = process.env.IFTTT_WEBHOOK_KEY;
    if (!key) return "IFTTT protocols offline. Webhook key missing, Sir.";
    try {
        const res = await fetch(`https://maker.ifttt.com/trigger/${event}/with/key/${key}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value1: value })
        });
        return res.ok ? `Automation protocol ${event} triggered, Sir.` : "IFTTT rejected the signal.";
    } catch (e) { return "IFTTT uplink error, Sir."; }
}

async function executeDesktopCmd(app) {
    // SECURITY WARNING: This ONLY works if Olivia is running on your local machine.
    // It will not work on Render.com.
    const { exec } = await import('child_process');
    return new Promise((resolve) => {
        exec(`start ${app}`, (error) => {
            if (error) resolve(`Failed to execute protocol for ${app}, Sir. Check local environment.`);
            else resolve(`Protocol ${app} executed successfully on the host machine, Sir.`);
        });
    });
}

/**
 * MASTER TOOL PARSER
 */
async function processAiTools(aiText, jid) {
    if (!aiText) return aiText;
    let finalOutput = aiText;

    // 0. Preferences
    const prefRegex = /\[SAVE_PREF:\s*(.+?)\s*\|\s*(.+?)\]/gi;
    let pMatch;
    while ((pMatch = prefRegex.exec(aiText)) !== null) {
        preferences[pMatch[1].trim().toLowerCase()] = pMatch[2].trim();
        savePrefs();
        finalOutput += `\n\n[VAULT UPDATED: ${pMatch[1]} learned, Sir.]`;
    }
    finalOutput = finalOutput.replace(prefRegex, '');

    // 1. Weather
    const weatherRegex = /\[GET_WEATHER:\s*(.+?)\]/gi;
    let wMatch;
    while ((wMatch = weatherRegex.exec(aiText)) !== null) {
        const info = await getWeather(wMatch[1]);
        finalOutput += `\n\n[SYSTEM INTEL: ${info}]`;
    }
    finalOutput = finalOutput.replace(weatherRegex, '');

    // 2. News
    const newsRegex = /\[GET_NEWS(?::\s*(.+?))?\]/gi;
    let nMatch;
    while ((nMatch = newsRegex.exec(aiText)) !== null) {
        const intel = await getNews(nMatch[1]);
        finalOutput += `\n\n[GLOBAL BRIEFING: ${intel}]`;
    }
    finalOutput = finalOutput.replace(newsRegex, '');

    // 3. Home Assistant
    const homeRegex = /\[HOME_ACTION:\s*(.+?)\s*\|\s*(.+?)\]/gi;
    let hMatch;
    while ((hMatch = homeRegex.exec(aiText)) !== null) {
        const res = await homeAssistantAction(hMatch[1], hMatch[2]);
        finalOutput += `\n\n[HOME CORE: ${res}]`;
    }
    finalOutput = finalOutput.replace(homeRegex, '');

    // 4. IFTTT
    const iftttRegex = /\[IFTTT_TRIGGER:\s*(.+?)\s*\|\s*(.+?)\]/gi;
    let iMatch;
    while ((iMatch = iftttRegex.exec(aiText)) !== null) {
        const res = await triggerIFTTT(iMatch[1], iMatch[2]);
        finalOutput += `\n\n[PROTOCOL ACTIVATED: ${res}]`;
    }
    finalOutput = finalOutput.replace(iftttRegex, '');

    // 5. Google Calendar Briefing
    const gCalRegex = /\[GET_CALENDAR\]/gi;
    if (gCalRegex.test(aiText)) {
        try {
            if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
                const events = await getTodayEvents(); 
                finalOutput += `\n\n[CALENDAR BRIEFING: ${events.length > 0 ? events.join(', ') : 'No events today, Sir.'}]`;
            } else {
                finalOutput += `\n\n[CALENDAR: Connection pending. Sir, please authorize Google Sync.]`;
            }
        } catch (e) { finalOutput += `\n\n[CALENDAR: Downlink error.]`; }
    }
    finalOutput = finalOutput.replace(gCalRegex, '');

    // 6. Gmail Briefing
    const gMailRegex = /\[GET_EMAILS\]/gi;
    if (gMailRegex.test(aiText)) {
        finalOutput += `\n\n[MAIL INTEL: Syncing with Gmail core... Feature currently in sandbox mode, Sir.]`;
    }
    finalOutput = finalOutput.replace(gMailRegex, '');

    // 7. Trends Intel
    const trendsRegex = /\[GET_TRENDS\]/gi;
    if (trendsRegex.test(aiText)) {
        const last = trendsData.lastUpdate ? new Date(trendsData.lastUpdate).toLocaleTimeString() : 'Never';
        finalOutput += `\n\n[TRENDS INTEL: Last updated at ${last}. Cars: ${trendsData.cars.length} updates. Design: ${trendsData.design.length} updates.]`;
    }
    // 8. Desktop Control
    const deskRegex = /\[OPEN_APP:\s*(.+?)\]/gi;
    let dMatch;
    while ((dMatch = deskRegex.exec(aiText)) !== null) {
        const res = await executeDesktopCmd(dMatch[1]);
        finalOutput += `\n\n[HOST COMMAND: ${res}]`;
    }
    finalOutput = finalOutput.replace(deskRegex, '');

    return finalOutput.trim();
}

async function getGroqResponse(message, history = [], from = "") {
    if (!groq) {
        console.error('❌ Groq client not initialized. GROQ_API_KEY may be missing from Render environment variables.');
        return "Groq AI is not configured. Please check the server environment variables.";
    }
    try {
        const tone = globalSettings.personality === 'friendly' 
            ? "Warm, helpful, and friendly. Use a casual but respectful tone." 
            : "Professional, witty, and exceptionally intelligent. Act as a digital butler.";

        const isOwner = (from === OWNER_JID || from === OWNER_LID);
        const addressing = isOwner 
            ? "Always address Subhash as 'Sir' or 'Sir Subhash'. Use Singlish where appropriate." 
            : "You are speaking to a Guest/Customer. Be respectful, professional, and helpful. Do NOT call them Sir Subhash. Instead, be helpful with 69 Studio related queries.";
        
        const messages = [
            {
                role: "system",
                content: `Role: You are Olivia, the high-end virtual concierge for 69 Studio. 
                Focus: You assist Subhash (Owner) and also handle customer leads.
                Current Interlocutor: ${isOwner ? "Subhash (Your Boss)" : "A Guest/Customer"}
                Tone: ${tone}
                Addressing: ${addressing}
                
                Preference Vault:
                - You MUST remember Subhash's favorites (colors, food, hobbies).
                - Use [SAVE_PREF: category | value] to store a preference.
                - Current Preferences: ${JSON.stringify(preferences)}

                Health & Habits Tracking:
                - Remind Subhash to drink water or take breaks if the conversation is long or late.
                - Use [REMIND_HEALTH: msg] for health nudges.

                Language Protocol (CRITICAL):
                - Subhash prefers "Singlish" (Sinhala words in English alphabet). 
                - If in Friendly Mode, speak naturally in Singlish (e.g., "Sir, wede iwarayi", "Oyaata kohomada?").
                - If Subhash speaks formal Sinhala (සිංහල), reply in formal Sinhala.
                
                Tool Integration:
                - [SET_REMINDER: msg | time], [ADD_TODO: task], [SAVE_NOTE: text]
                - [SAVE_PREF: category | value], [GET_CALENDAR], [GET_EMAILS], [GET_TRENDS]
                - [GET_WEATHER: City], [GET_NEWS: Topic], [OPEN_APP: Name]
                - [HOME_ACTION: entity | command], [IFTTT_TRIGGER: event | data]
                - [BOOK_APPT: Name | Date | Time | Service]
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
        aiResponse = await processAiTools(aiResponse, userId);
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

// API: Vision Assistant (Image Analysis)
app.post('/api/assistant/vision', async (req, res) => {
    const { pass: password, q, query, image, imageBase64, mimeType, model: modelType } = req.body;

    if (!checkAuth(password)) return res.status(403).json({ error: 'Unauthorized' });

    const systemPrompt = `You are Subhash's personal AI assistant. Analyze the image provided and give a concise, helpful response. If asked a specific question about it, answer that. Be professional and brief.`;
    const finalQuery = q || query || "Describe this image.";
    const finalImage = (image || imageBase64 || "").includes('base64,') ? (image || imageBase64).split(',')[1] : (image || imageBase64);

    if (!finalImage) return res.status(400).json({ error: 'Image data missing' });

    try {
        let answer = '';

        if (modelType === 'gemini') {
            const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
            const result = await model.generateContent([
                systemPrompt + (finalQuery ? `\n\nUser question: ${finalQuery}` : '\n\nDescribe this image.'),
                { inlineData: { data: finalImage, mimeType: mimeType || 'image/jpeg' } }
            ]);
            answer = result.response.text();
        } else if (modelType === 'chatgpt') {
            const completion = await openai.chat.completions.create({
                model: 'gpt-4o',
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: systemPrompt + (finalQuery ? `\n\nUser question: ${finalQuery}` : '\n\nDescribe this image.') },
                        { type: 'image_url', image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${finalImage}` } }
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

// --- PWA CHAT SYNC ENDPOINTS ---

function loadPwaHistory() {
    if (!fs.existsSync(pwaHistoryFile)) return {};
    try { return JSON.parse(fs.readFileSync(pwaHistoryFile)); }
    catch (e) { return {}; }
}

function savePwaHistory(history) {
    fs.writeFileSync(pwaHistoryFile, JSON.stringify(history, null, 2));
    notifyClients();
}

app.get('/api/assistant/chat/load', (req, res) => {
    const { pass: password } = req.query;
    if (!checkAuth(password)) return res.status(403).json({ error: 'Unauthorized' });
    
    const history = loadPwaHistory();
    res.json(history[password] || []);
});

app.post('/api/assistant/chat/save', (req, res) => {
    const { pass: password, messages } = req.body;
    if (!checkAuth(password)) return res.status(403).json({ error: 'Unauthorized' });

    const history = loadPwaHistory();
    history[password] = messages;
    savePwaHistory(history);
    res.json({ success: true });
});

// --- MEMORY ENDPOINTS ---

function loadMemories() {
    if (!fs.existsSync(memoryFile)) return {};
    try { return JSON.parse(fs.readFileSync(memoryFile)); }
    catch (e) { return {}; }
}

function saveMemories(memories) {
    fs.writeFileSync(memoryFile, JSON.stringify(memories, null, 2));
}

app.get('/api/assistant/memory/load', (req, res) => {
    const { pass: password } = req.query;
    if (!checkAuth(password)) return res.status(403).json({ error: 'Unauthorized' });
    
    const memories = loadMemories();
    res.json(memories[password] || []);
});

app.post('/api/assistant/memory/save', (req, res) => {
    const { pass: password, memory } = req.body;
    if (!checkAuth(password)) return res.status(403).json({ error: 'Unauthorized' });

    const memories = loadMemories();
    if (!memories[password]) memories[password] = [];
    if (!memories[password].includes(memory)) {
        memories[password].push(memory);
        // Keep only last 50 memories
        saveMemories(memories);
    }
    res.json({ success: true });
});

// --- BIOMETRIC AUTH ENDPOINTS (v8.3) ---
// --- BIOMETRIC AUTH ENDPOINTS (Consolidated at the end) ---

app.get('/api/assistant/ask', async (req, res) => {
    const { pass: password, q: query, model: modelType, system: customSystem, history: historyRaw } = req.query;

    if (!checkAuth(password)) return res.status(403).json({ error: 'Unauthorized' });

    try {
        const rawHistory = Object.fromEntries(chatHistory);
        const leadsSummary = Object.entries(rawHistory).map(([jid, msgs]) => {
            const cleanJid = jid.split('@')[0];
            const lastMsg = msgs[msgs.length - 1]?.parts[0]?.text || "No message";
            return `Lead ${cleanJid}: ${lastMsg}`;
        }).join('\n');

        const memories = loadMemories()[password] || [];
        const memoryContext = memories.length > 0 ? `KEY RECENT MEMORIES ABOUT SUBHASH:\n${memories.join('\n')}` : "No specific memories yet.";
        
        const internalSystem = `You are Subhash's loyal, smart and charming AI Personal Assistant named Olivia. 
        Your boss and creator is Subhash. NEVER ask for his name or purpose. 
        
        LANGUAGE PROTOCOL:
        - Use "Singlish" (Sinhala words in English alphabet) for a natural Sri Lankan feel.
        - Examples: "Sir, wede iwarayi", "Dannam karannam Sir", "Kohomada Sirta?".
        - Reply in English for technical/formal tasks.
        
        CONTEXT FROM RECENT WHATSAPP LEADS:
        ${leadsSummary || "No active leads."}

        ${memoryContext}
        
        TOOL INTEGRATION:
        - [SET_REMINDER: msg | time], [SAVE_NOTE: text], [GET_WEATHER: location], [ADD_TODO: task]
        - [GET_NEWS], [GEN_IMAGE: description], [TRACK_EXPENSE: amount | desc]
        `;

        const systemPrompt = customSystem ? decodeURIComponent(customSystem) : internalSystem;

        let history = [];
        if (historyRaw) {
            try { 
                const parsed = JSON.parse(decodeURIComponent(historyRaw));
                history = parsed.slice(-6).map(h => ({
                    role: h.role === 'ai' || h.role === 'model' ? 'assistant' : 'user',
                    content: h.text || ""
                }));
            } catch (e) { console.error('History parse error:', e); }
        }

        let answer = "";

        if (modelType === "gemini") {
            const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
            const chat = model.startChat({
                history: history.map(h => ({
                    role: h.role === "assistant" ? "model" : "user",
                    parts: [{ text: h.content }]
                }))
            });
            const result = await chat.sendMessage(`${systemPrompt}\n\nUser: ${query}`);
            const response = await result.response;
            answer = response.text();
        } else if (modelType === "chatgpt") {
            const completion = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: [
                    { role: "system", content: systemPrompt },
                    ...history,
                    { role: "user", content: query }
                ],
            });
            answer = completion.choices[0].message.content;
        } else { // Default to Groq Llama
            if (!groq) throw new Error('Groq client not initialized. Add GROQ_API_KEY to Render environment.');
            const chatCompletion = await groq.chat.completions.create({
                messages: [
                    { role: "system", content: systemPrompt },
                    ...history,
                    { role: "user", content: query }
                ],
                model: "llama-3.3-70b-versatile",
                temperature: 0.7,
                max_tokens: 512,
            });
            answer = chatCompletion.choices[0].message.content;
        }

        answer = await processAiTools(answer, "PWA_CLIENT");
        answer = processAiResponseForTodos(answer);
        res.json({ answer });
    } catch (error) {
        console.error("Assistant Error:", error.message);
        res.status(500).json({ error: 'AI Error: ' + error.message });
    }
});

app.post('/api/assistant/tts', async (req, res) => {
    const { pass, text, voiceId } = req.body;
    if (!checkAuth(pass)) return res.status(403).json({ error: 'Unauthorized' });
    if (!xiClient) return res.status(500).json({ error: 'ElevenLabs not configured' });

    try {
        const audio = await xiClient.generate({
            voice: voiceId || "Lcf7u9Pa96uMc9P6vV3L", // Default: Bella (Sinhala Girl tone)
            text: text,
            model_id: "eleven_multilingual_v2",
            voice_settings: {
                stability: 0.4,
                similarity_boost: 0.8,
                style: 0.05,
                use_speaker_boost: true
            }
        });

        res.setHeader('Content-Type', 'audio/mpeg');
        audio.pipe(res);
    } catch (e) {
        console.error('TTS Error:', e.message);
        res.status(500).json({ error: 'TTS Generation Failed' });
    }
});

// --- VOICE CLONING ENDPOINT (v7.5) ---
app.post('/api/assistant/voice-clone', upload.single('sample'), async (req, res) => {
    const { pass } = req.body;
    if (!checkAuth(pass)) return res.status(403).json({ error: 'Unauthorized' });
    if (!xiClient) return res.status(500).json({ error: 'ElevenLabs not configured' });
    if (!req.file) return res.status(400).json({ error: 'No audio sample uploaded' });

    try {
        console.log(`🎙️ Cloning voice from sample: ${req.file.originalname}`);
        
        const voice = await xiClient.voices.add({
            name: `Clone_${Date.now()}`,
            description: "Custom clone from Olivia PWA",
            files: [fs.createReadStream(req.file.path)]
        });

        // Cleanup local file
        fs.unlinkSync(req.file.path);

        res.json({ success: true, voiceId: voice.voice_id });
    } catch (e) {
        console.error('Cloning Error:', e.message);
        if (req.file) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: 'Voice Cloning Failed: ' + e.message });
    }
});

// --- TREND MONITORING BACKGROUND JOB ---
async function monitorTrends() {
    console.log('📡 JARVIS: Updating Global Trend Intel...');
    const carNews = await getNews('Luxury Cars 2026');
    const designNews = await getNews('Graphic Design Trends');
    
    trendsData.cars = carNews.split('\n').filter(l => l.startsWith('- '));
    trendsData.design = designNews.split('\n').filter(l => l.startsWith('- '));
    trendsData.lastUpdate = new Date().toISOString();
    saveTrends();
}

// Update trends ogni 6 ore
setInterval(monitorTrends, 6 * 60 * 60 * 1000);

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
            const qrPath = path.join(__dirname, 'public', 'qr.png');
            const qr_svg = qrImage.image(qr, { type: 'png' });
            qr_svg.pipe(fs.createWriteStream(qrPath));
            console.log(`🖼️ QR Code saved to ${qrPath}`);
            notifyClients('status', { wa: 'qr', hasQr: true });
        }

        if (connection === 'close') {
            waConnectionStatus = 'disconnected';
            notifyClients('status', { wa: 'disconnected' });
            const code = (new Boom(lastDisconnect?.error)).output?.statusCode;
            console.log(`❌ Connection Closed. Reason: ${code}`);
            
            const shouldReconnect = code !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log('🔄 Reconnecting...');
                startBot();
            } else {
                console.log('🚪 Logged out. Delete auth_info_baileys and scan again.');
                if (fs.existsSync(path.join(__dirname, 'public', 'qr.png'))) {
                    try { fs.unlinkSync(path.join(__dirname, 'public', 'qr.png')); } catch(e) {}
                }
            }
        } else if (connection === 'open') {
            waConnectionStatus = 'connected';
            notifyClients('status', { wa: 'connected' });
            // Remove QR if exists
            if (fs.existsSync(path.join(__dirname, 'public', 'qr.png'))) {
                try { fs.unlinkSync(path.join(__dirname, 'public', 'qr.png')); } catch(e) {}
            }
            const botName = sock.user.name || 'Bot';
            console.log(`--- ✅ BOT IS READY! YOUR AI IS NOW ACTIVE ---`);
            console.log(`Verified as: ${botName} (${sock.user.id.split(':')[0]})`);
        } else {
            // Probably connecting...
            waConnectionStatus = 'connecting';
            notifyClients('status', { wa: 'connecting' });
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];

        // DEBUG: Log ALL incoming events for visibility
        if (m.type === 'notify' && msg) {
            const from = msg.key.remoteJid;
            const isMe = msg.key.fromMe;
            console.log(`🔔 Raw Message from ${from} (fromMe: ${isMe})`);
            
            // --- DETECT MANUAL INTERVENTION ---
            if (isMe) {
                const muteUntil = Date.now() + 30 * 60 * 1000;
                adminMuteMap.set(from, muteUntil);
                console.log(`🔇 Manual reply detected by Admin. Olivia is now MUTED for ${from} until ${new Date(muteUntil).toLocaleTimeString()}.`);
                notifyClients(); // Refresh Pulse in PWA
            } else {
                console.log(`📩 Incoming message object captured. Remote JID: ${from}`);
            }
        }

        if (!msg || !msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        
        // --- CHECK MUTE STATUS ---
        const muteUntil = adminMuteMap.get(from);
        if (muteUntil && muteUntil > Date.now()) {
            const remaining = Math.round((muteUntil - Date.now()) / 60000);
            console.log(`⏳ Skip auto-reply for ${from}. Manual override active for ${remaining} more mins.`);
            return;
        }

        // --- IMPROVED MESSAGE UNWRAPPING ---
        // Handle viewOnce, ephemeral, etc.
        const msgContent = msg.message.ephemeralMessage?.message || 
                           msg.message.viewOnceMessage?.message || 
                           msg.message.viewOnceMessageV2?.message || 
                           msg.message;

        let body = (msgContent.conversation || msgContent.extendedTextMessage?.text || msgContent.imageMessage?.caption);

        // --- VOICE MESSAGE HANDLING ---
        if (msgContent.audioMessage && !body) {
            console.log(`🎤 Received voice message from ${from}. Transcribing...`);
            try {
                const buffer = await downloadMediaMessage(
                    msg,
                    'buffer',
                    {},
                    { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                );
                
                const tempFilename = `temp_${Date.now()}.ogg`;
                fs.writeFileSync(tempFilename, buffer);
                
                const transcription = await groq.audio.transcriptions.create({
                    file: fs.createReadStream(tempFilename),
                    model: 'whisper-large-v3-turbo',
                });
                
                body = transcription.text;
                console.log(`📝 Transcribed: ${body}`);
                fs.unlinkSync(tempFilename); // Cleanup
            } catch (vError) {
                console.error('❌ Voice Transcribe Error:', vError.message);
                if (vError.message.includes('media key')) {
                    console.log('💡 Note: This can happen with expired or unsupported voice messages.');
                }
            }
        } else if (!body) {
            // Log other media types briefly
            const type = Object.keys(msgContent || {})[0];
            if (type !== 'protocolMessage' && type !== 'senderKeyDistributionMessage') {
                console.log(`📎 Received ${type} from ${from}. Skipping text processing.`);
            }
        }

        if (body) {
            console.log(`📩 New message from ${from}: ${body}`);
            try {
                // Ensure we handle both user JIDs and LID (Linked ID)
                if (from.endsWith('@s.whatsapp.net') || from.endsWith('@lid')) {
                    if (!chatHistory.has(from)) {
                        chatHistory.set(from, []);
                        console.log(`🆕 Registered new contact: ${from}`);
                    }
                    const history = chatHistory.get(from);

                    // --- IMMEDIATE HISTORY SAVE & SYNC ---
                    // Save user message to history BEFORE AI thinking starts
                    history.push({
                        role: "user",
                        parts: [{ text: body }],
                        time: new Date().toISOString()
                    });
                    saveHistory(); // This triggers SSE 'update' alert to PWA instantly
                    console.log(`💾 Lead captured & PWA notified for ${from.split('@')[0]}`);

                    // --- IMMEDIATE PUSH ALERT ---
                    const pushTitle = `WhatsApp: ${from.split('@')[0]} 💬`;
                    const pushBody = body.length > 80 ? body.substring(0, 80) + '...' : body;
                    
                    try {
                        console.log(`📡 Triggering Push Alert for ${from.split('@')[0]}...`);
                        sendPushToAll(pushTitle, pushBody).catch(e => {
                            console.error('❌ Push Alert Failed:', e.message);
                        });
                    } catch (pushErr) {
                        console.error('❌ Push System Error:', pushErr.message);
                    }

                    // Get AI Response using Groq - Pass the 'from' JID for identity checks
                    let aiResponse = await getGroqResponse(body, history, from);
                    aiResponse = processAiResponseForTodos(aiResponse);
                    aiResponse = processAiResponseForBookings(aiResponse, from);
                    aiResponse = await processAiTools(aiResponse, from);

                    // Add AI reply to history
                    history.push({
                        role: "model",
                        parts: [{ text: aiResponse }],
                        time: new Date().toISOString()
                    });
                    saveHistory(); // Save again with AI response
                    
                    console.log(`AI Assistant Replying to ${from}: ${aiResponse}`);
                    
                    if (globalSettings.autoReply) {
                        await sock.sendMessage(from, { text: aiResponse });
                    } else {
                        console.log(`🔇 Auto-reply is DISABLED. Message logged but not sent.`);
                    }
                }
            } catch (error) {
                console.error('AI Error:', error.message);
            }
        }
    });
}

// --- BIOMETRIC SECURITY ENDPOINTS ---

app.post('/api/auth/biometric/register', (req, res) => {
    const { pass, keyId } = req.body;
    if (pass !== (process.env.ADMIN_PASSWORD || '69studio123')) return res.status(401).json({ error: 'Unauthorized' });
    
    biometricKeys.deviceKey = keyId;
    saveBiometricKeys();
    res.json({ success: true });
});

app.post('/api/auth/biometric/verify', (req, res) => {
    const { pass, keyId } = req.body;
    if (pass !== (process.env.ADMIN_PASSWORD || '69studio123')) return res.status(401).json({ error: 'Unauthorized' });
    
    if (biometricKeys.deviceKey === keyId) {
        res.json({ success: true });
    } else {
        res.status(401).json({ error: 'Invalid biometric key' });
    }
});

// --- FINAL EXPRESS WRAPUP ---
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- SERVER STARTUP ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Olivia Core Elite v8.3 running on port ${PORT}`);
    
    // --- DIAGNOSTICS ---
    console.log('📊 Environment Status:');
    console.log(`  - GROQ_API_KEY: ${process.env.GROQ_API_KEY ? '✅ set' : '❌ missing'}`);
    console.log(`  - ELEVENLABS_API_KEY: ${process.env.ELEVENLABS_API_KEY ? '✅ set' : '❌ missing'}`);
    console.log(`  - GOOGLE_CLIENT_EMAIL: ${process.env.GOOGLE_CLIENT_EMAIL ? '✅ set' : '❌ missing'}`);
    console.log(`  - GOOGLE_PRIVATE_KEY: ${process.env.GOOGLE_PRIVATE_KEY ? '✅ set' : '❌ missing'}`);
    console.log(`  - GOOGLE_CALENDAR_ID: ${process.env.GOOGLE_CALENDAR_ID ? '✅ set' : '❌ missing'}`);

    if (process.env.RENDER_EXTERNAL_URL) {
        setInterval(async () => {
            try { await fetch(process.env.RENDER_EXTERNAL_URL); } catch (e) {}
        }, 10 * 60 * 1000);
    }

    console.log('⏳ Olivia Core: Waiting 5s for server stabilization before starting AI Bot...');
    setTimeout(() => {
        console.log('🤖 AI Bot starting now...');
        startBot();
    }, 5000);
});

function cleanKey(key) {
    if (!key) return null;
    let clean = key;
    if (clean.startsWith('"') && clean.endsWith('"')) {
        clean = clean.substring(1, clean.length - 1);
    }
    return clean.replace(/\\n/g, '\n');
}
