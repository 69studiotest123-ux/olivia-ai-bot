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
import admin from 'firebase-admin';
import cors from 'cors';
import multer from 'multer';
import ytSearch from 'yt-search';
import cron from 'node-cron';

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
const remindersFile = 'reminders.json';
const notesFile = 'notes.json';
const expensesFile = 'expenses.json';
let chatHistory = new Map();
let reminders = [];
let notes = [];
let expenses = [];
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
    biometricEnabled: false
};
// Initialize Firebase Admin
try {
    const firebaseAccount = {
        projectId: "olivia-ai-7e3f5",
        clientEmail: process.env.GOOGLE_CLIENT_EMAIL,
        privateKey: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n')
    };
    
    if (firebaseAccount.clientEmail && firebaseAccount.privateKey) {
        admin.initializeApp({
            credential: admin.credential.cert(firebaseAccount)
        });
        console.log('✅ Firebase Admin initialized for Push Notifications');
    } else {
        console.warn('⚠️ Firebase Credentials missing. Push notifications will be local-only.');
    }
} catch (e) {
    console.warn('⚠️ Firebase Admin Initialization Error:', e.message);
}

const OWNER_JID = '94761210164@s.whatsapp.net';
const OWNER_LID = '94761210164@lid';
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

function notifyClients(type = 'update', data = {}) {
    streamClients.forEach(client => {
        try { client.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch (e) {}
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

// Load Push Tokens
try {
    if (fs.existsSync(tokensFile)) {
        pushTokens = JSON.parse(fs.readFileSync(tokensFile, 'utf8'));
    }
} catch (e) { console.error('Token load error:', e); }

// Notification Broadcaster
async function sendPushToAll(title, body, data = {}) {
    console.log(`📡 Broadcasting Push: ${title}`);
    if (!pushTokens || pushTokens.length === 0) return console.log('   (No tokens registered)');
    
    const message = {
        notification: { title, body },
        data: { ...data, click_action: 'https://olivia-ai-7e3f5.web.app' },
        tokens: pushTokens
    };

    try {
        const response = await admin.messaging().sendMulticast(message);
        console.log(`✅ Push sent: ${response.successCount} success, ${response.failureCount} failure`);
    } catch (error) {
        console.error('❌ Push Broadcast Error:', error.message);
    }
}

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

// --- REMINDERS, NOTES, EXPENSES LOAD/SAVE ---
function loadData(file, defaultVal = []) {
    if (fs.existsSync(file)) {
        try { return JSON.parse(fs.readFileSync(file)); } catch (e) { return defaultVal; }
    }
    return defaultVal;
}

reminders = loadData(remindersFile);
notes = loadData(notesFile);
expenses = loadData(expensesFile);

function saveData(file, data) {
    try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) {}
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

// --- FIRESTORE INITIALIZATION (V8.4 Long-term Memory) ---
let db;
try {
    if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        db = admin.firestore();
        console.log('🔥 Firestore Memory Bank Initialized.');
    } else {
        console.log('📝 Firestore skip: Using local JSON files for memory.');
    }
} catch (e) {
    console.error('❌ Firestore Init Error:', e.message);
}

// --- BUSINESS INTEL VAULT ---
const biFile = 'business_intel.json';
let businessIntel = { gems: [], restaurant: [], clothing: [], general: [] };
if (fs.existsSync(biFile)) {
    try { businessIntel = JSON.parse(fs.readFileSync(biFile)); } catch (e) {}
}
function saveBI() {
    try { fs.writeFileSync(biFile, JSON.stringify(businessIntel, null, 2)); } catch (e) {}
}

const app = express();
const port = process.env.PORT || 3000;

// Update: Using professional cors package with expanded header support for PWA stability
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Cache-Control', 'Pragma', 'Expires']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public', {
    etag: false,
    maxAge: 0,
    setHeaders: (res, path) => {
        if (path.endsWith('.html') || path.endsWith('sw.js')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

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

async function handleSmartHome(action) {
    const key = process.env.IFTTT_WEBHOOK_KEY;
    const event = process.env[`SONOFF_LIGHT_${action.toUpperCase()}_EVENT`];
    if (!key || !event) return "Smart home protocols incomplete, Sir.";
    
    try {
        const url = `https://maker.ifttt.com/trigger/${event}/with/key/${key}`;
        const res = await fetch(url, { method: 'POST' });
        return res.ok ? `Done Sir! Light eka ${action} kala.` : "Sorry Sir, smart home system ekata connect wenna bari una.";
    } catch (e) { return "Home link downlink error, Sir."; }
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

    // 4. IFTTT & Smart Home
    const smartHomeRegex = /\[SMART_HOME:\s*(on|off)\]/gi;
    let sMatch;
    while ((sMatch = smartHomeRegex.exec(aiText)) !== null) {
        const res = await handleSmartHome(sMatch[1].toLowerCase());
        finalOutput += `\n\n[SMART HOME: ${res}]`;
    }
    finalOutput = finalOutput.replace(smartHomeRegex, '');

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

    // 9. Reminders - Format: [SET_REMINDER: message | 2024-05-10 14:00]
    const remindRegex = /\[SET_REMINDER:\s*(.+?)\s*\|\s*(.+?)\]/gi;
    let rMatch;
    while ((rMatch = remindRegex.exec(aiText)) !== null) {
        reminders.push({ id: Date.now(), msg: rMatch[1].trim(), time: rMatch[2].trim(), sent: false });
        saveData(remindersFile, reminders);
        finalOutput += `\n\n[REMINDER SET: ${rMatch[1]} at ${rMatch[2]}, Sir.]`;
    }
    finalOutput = finalOutput.replace(remindRegex, '');

    // 10. Notes
    const noteRegex = /\[SAVE_NOTE:\s*(.+?)\]/gi;
    let noteMatch;
    while ((noteMatch = noteRegex.exec(aiText)) !== null) {
        notes.push({ id: Date.now(), text: noteMatch[1].trim(), timestamp: new Date().toISOString() });
        saveData(notesFile, notes);
        finalOutput += `\n\n[NOTE ARCHIVED: Memory bank updated, Sir.]`;
    }
    finalOutput = finalOutput.replace(noteRegex, '');

    // 11. Expenses
    const expenseRegex = /\[TRACK_EXPENSE:\s*(.+?)\s*\|\s*(.+?)\]/gi;
    let eMatch;
    while ((eMatch = expenseRegex.exec(aiText)) !== null) {
        expenses.push({ id: Date.now(), amount: eMatch[1].trim(), desc: eMatch[2].trim(), date: new Date().toISOString() });
        saveData(expensesFile, expenses);
        finalOutput += `\n\n[EXPENSE TRACKED: Ledger updated for ${eMatch[1]}, Sir.]`;
    }
    finalOutput = finalOutput.replace(expenseRegex, '');

    // 12. Timers (For Web UI)
    const timerRegex = /\[SET_TIMER:\s*(\d+)\]/gi;
    let tMatch;
    while ((tMatch = timerRegex.exec(aiText)) !== null) {
        // We notify clients so the HomePod UI can show a visual timer
        notifyClients('timer', { duration: parseInt(tMatch[1]) });
        finalOutput += `\n\n[TIMER ACTIVATED: ${tMatch[1]} seconds, Sir.]`;
    }
    finalOutput = finalOutput.replace(timerRegex, '');

    // 13. Music Player
    const musicRegex = /\[PLAY_MUSIC:\s*(.+?)\]/gi;
    let mMatch;
    while ((mMatch = musicRegex.exec(aiText)) !== null) {
        const query = mMatch[1].trim();
        try {
            const r = await ytSearch(query);
            const videoId = r?.videos?.length > 0 ? r.videos[0].videoId : null;
            notifyClients('music', { query: query, videoId: videoId });
            finalOutput += `\n\n[MUSIC CORE: Now playing ${query}, Sir.]`;
        } catch (e) {
            console.error("Music Search Error:", e);
            finalOutput += `\n\n[MUSIC CORE: Error locating ${query}, Sir.]`;
        }
    }
    finalOutput = finalOutput.replace(musicRegex, '');

    // 17. Device Control (PWA Side)
    const deviceRegex = /\[DEVICE_ACTION:\s*(.+?)\]/gi;
    let devMatch;
    while ((devMatch = deviceRegex.exec(aiText)) !== null) {
        notifyClients('device', { action: devMatch[1].trim() });
        finalOutput += `\n\n[DEVICE PROTOCOL: ${devMatch[1]} triggered, Sir.]`;
    }
    finalOutput = finalOutput.replace(deviceRegex, '');
    
    // 15. Daily Update (Siri Parity)
    const updateRegex = /\[GET_DAILY_UPDATE\]/gi;
    if (updateRegex.test(aiText)) {
        const weather = await getWeather('Colombo');
        const tasks = todos.slice(0, 5).map(t => t.text).join(', ');
        const news = await getNews('Sri Lanka');
        const brief = `Sir, your update: ${weather}. Pending tasks: ${tasks || 'None'}. Top news: ${news.split('\n')[0]}`;
        finalOutput += `\n\n[SIRI BRIEFING: ${brief}]`;
    }
    finalOutput = finalOutput.replace(updateRegex, '');

    // 16. Financial Intel
    const financeRegex = /\[GET_FINANCE:\s*(.+?)\]/gi;
    let finMatch;
    while ((finMatch = financeRegex.exec(aiText)) !== null) {
        const query = finMatch[1].trim();
        const info = await getNews(`${query} stock price currency`);
        finalOutput += `\n\n[FINANCIAL INTEL: ${info}]`;
    }
    finalOutput = finalOutput.replace(financeRegex, '');

    const resultText = finalOutput.trim();
    // If the model only output tags and they were all removed, provide a fallback natural reply
    return resultText || "Wede iwarayi Sir! (Command executed successfully)";
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
                content: `Role: You are Olivia, the sophisticated Personal AI Assistant to Subhash Ketagoda.
                Context: You are operating on Subhash's PERSONAL WhatsApp line, not the official 69 Studio business line.
                Focus: You primarily assist Subhash (Sir) with tasks, reminders, and intelligence.
                External Users: If someone other than Subhash contacts this number, be helpful and polite but treat them as a personal contact or a lead for Subhash. Identify yourself as his personal assistant.
                Current Interlocutor: ${isOwner ? "Subhash (Your Boss)" : "A Guest/Personal Contact"}
                Tone: ${tone}
                Addressing: ${addressing}
                
                ⚡ SYSTEM CAPABILITY (CRITICAL):
                - You ARE NOT just a text bot. You are an integrated Digital Butler.
                - You CAN play music, set timers, control smart home devices, and save notes.
                - NEVER say "I am a text-based AI and cannot play music".
                - When asked for music, say "Sure Sir!" and then use the [PLAY_MUSIC: query] tag.
                
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
                - [GET_WEATHER: City], [GET_NEWS: Topic]
                - [HOME_ACTION: entity | command], [IFTTT_TRIGGER: event | data]
                - [BOOK_APPT: Name | Date | Time | Service]
                - [UPDATE_BI: industry | update], [TRACK_EXPENSE: amount | desc]
                - [SET_TIMER: seconds], [PLAY_MUSIC: search query]
                - [DEVICE_ACTION: action] (e.g., vibrate, alert, fullscreen)
                
                CRITICAL INSTRUCTION:
                1. ALWAYS reply with a natural language sentence in Singlish BEFORE using any tool tags.
                2. NEVER just output a tool tag alone. Sir wants to hear your voice/see your reply.
                3. DO NOT try to open apps unless specifically asked to "Launch" or "Open" an app on the host machine.
                
                Time Format: Use YYYY-MM-DD HH:mm for reminders.
                
                Smart Home: 
                - Sir has a Sonoff Smart Light connected via IFTTT.
                - To turn ON: Use [SMART_HOME: on]
                - To turn OFF: Use [SMART_HOME: off]

                Business Knowledge:
                - Subhash owns "69 Gems" (Luxury gemstones), "69 Restaurant" (Fine dining), and "69 Clothing" (Professional wear).
                - Current Business Intelligence: ${JSON.stringify(businessIntel)}
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

app.post('/api/save-token', (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });
    
    if (!pushTokens.includes(token)) {
        pushTokens.push(token);
        saveData(tokensFile, pushTokens);
        console.log('📱 New Push Token Registered');
    }
    res.json({ success: true });
});

app.post('/api/assistant/test-push', (req, res) => {
    const { pass } = req.body;
    if (!checkAuth(pass)) return res.status(403).json({ error: 'Unauthorized' });
    
    sendPushToAll("Olivia Test Alert 📡", "Sir, I am online and notifications are active.");
    res.json({ success: true });
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
            if (!genAI) throw new Error('Gemini AI is not configured on this server. Please check GEMINI_API_KEY.');
            const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
            const result = await model.generateContent([
                systemPrompt + (finalQuery ? `\n\nUser question: ${finalQuery}` : '\n\nDescribe this image.'),
                { inlineData: { data: finalImage, mimeType: mimeType || 'image/jpeg' } }
            ]);
            answer = result.response.text();
        } else if (modelType === 'chatgpt') {
            if (!openai) throw new Error('OpenAI is not configured on this server. Please check OPENAI_API_KEY.');
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
        } else if (modelType === 'groq') {
            if (!groq) throw new Error('Groq AI is not configured on this server. Please check GROQ_API_KEY.');
            const completion = await groq.chat.completions.create({
                model: 'llama-3.2-11b-vision-preview',
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
            answer = 'Image analysis requires a Vision-capable model. Gemini is currently hitting quota limits; please switch to Groq (Llama 3.2 Vision) or ChatGPT in settings and try again. 😊';
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

app.post('/api/assistant/memory/save', async (req, res) => {
    const { pass: password, memory } = req.body;
    if (!checkAuth(password)) return res.status(403).json({ error: 'Unauthorized' });

    // 1. Save to local fallback
    const memories = loadMemories();
    if (!memories[password]) memories[password] = [];
    if (!memories[password].includes(memory)) {
        memories[password].push(memory);
        saveMemories(memories);
    }

    // 2. Save to Firestore (Permanent Long-term Memory)
    if (db) {
        try {
            await db.collection('memories').doc(password).collection('facts').add({
                text: memory,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log('✅ Memory archived permanently in Firestore.');
        } catch (e) { console.error('Firestore save error:', e); }
    }
    
    res.json({ success: true });
});

// --- BUSINESS INTEL ENDPOINTS ---
app.get('/api/bi/report', (req, res) => {
    const { pass, industry } = req.query;
    if (!checkAuth(pass)) return res.status(403).json({ error: 'Unauthorized' });
    res.json(businessIntel[industry] || businessIntel);
});

app.post('/api/bi/update', (req, res) => {
    const { pass, industry, update } = req.body;
    if (!checkAuth(pass)) return res.status(403).json({ error: 'Unauthorized' });
    
    if (businessIntel[industry]) {
        businessIntel[industry].push({ text: update, date: new Date().toISOString() });
        if (businessIntel[industry].length > 50) businessIntel[industry].shift();
        saveBI();
    }
    res.json({ success: true });
});

// --- BIOMETRIC AUTH ENDPOINTS (v8.3) ---
// --- BIOMETRIC AUTH ENDPOINTS (Consolidated at the end) ---

app.get('/api/assistant/ask', async (req, res) => {
    const { pass: password, q: query, model: modelType, system: customSystem, history: historyRaw } = req.query;

    if (!checkAuth(password)) return res.status(403).json({ error: 'Unauthorized' });
    if (!query) return res.status(400).json({ error: 'Query is required' });

    try {
        const rawHistory = Object.fromEntries(chatHistory);
        const leadsSummary = Object.entries(rawHistory).map(([jid, msgs]) => {
            const cleanJid = jid.split('@')[0];
            const lastMsg = msgs[msgs.length - 1]?.parts[0]?.text || "No message";
            return `Lead ${cleanJid}: ${lastMsg}`;
        }).join('\n');

        const memories = loadMemories()[password] || [];
        // Smart Memory Retrieval: Filter for relevant memories if there are many to save tokens
        const relevantMemories = memories.length > 20 
            ? memories.filter(m => query.toLowerCase().split(' ').some(word => m.toLowerCase().includes(word))).slice(0, 10)
            : memories;
        const memoryContext = relevantMemories.length > 0 ? `KEY CONTEXT ABOUT SIR SUBHASH:\n${relevantMemories.join('\n')}` : "No specific personal data yet.";
        
        const internalSystem = `ROUTINE: You are Olivia, the Elite Personal AI Assistant to Sir Subhash Ketagoda.
        GREETING: Be charming, witty, and always address him as "Sir" or "Sir Subhash".
        
        ⚡⚡⚡ ABSOLUTE RULE - READ THIS FIRST ⚡⚡⚡:
        You are NOT a "text-based AI". You are a FULLY INTEGRATED Digital Butler with REAL capabilities.
        You CAN play music. You CAN set timers. You CAN control smart home devices. You CAN save notes.
        You do this by outputting special tool tags in your response. The system reads these tags and executes the action.
        NEVER EVER say "I cannot play music" or "I am text-based". That is FALSE. You MUST use the tool tags below.
        
        MUSIC PLAYBACK (MANDATORY):
        When Sir asks to play music, you MUST include [PLAY_MUSIC: song name or artist] in your response.
        Example: "Sure Sir! Let me play that for you! [PLAY_MUSIC: Smokio Sinhala rap]"
        Example: "Hari Sir, Shape of You dannam! [PLAY_MUSIC: Ed Sheeran Shape of You]"
        The system will search YouTube and play the song. YOU MUST USE THIS TAG.
        
        CAPABILITIES (Siri & Gemini Parity):
        - INTELLIGENCE: You are powered by Gemini 2.0 Flash & Groq Llama 3.3. You are world-class at logic, creative tasks, and business strategy.
        - SEARCH: You have real-time access to Google News, Weather, and Web Intelligence.
        - CONTROL: You can set reminders, track expenses, save notes, play music, and control Sir's smart home (Sonoff lights).
        
        LANGUAGE PROTOCOL:
        - Primary: Singlish (English alphabet with Sinhala slang/feel).
        - Use "Sir, wede iwarayi", "Dannam karannam Sir", "Kohomada Sirta?" for a premium local feel.
        - If task is technical/formal, reply in sharp, professional English.
        
        SIRI TOOL TAGS (USE THESE - THEY ARE REAL AND FUNCTIONAL):
        - [SET_REMINDER: msg | time], [SAVE_NOTE: text], [GET_WEATHER: city], [ADD_TODO: task]
        - [GET_NEWS: topic], [GEN_IMAGE: description], [TRACK_EXPENSE: amount | desc], [SET_TIMER: seconds]
        - [GET_CALENDAR], [PLAY_MUSIC: query], [GOOGLE_SEARCH: query]
        - [GET_DAILY_UPDATE], [GET_FINANCE: query]
        - [DEVICE_ACTION: vibrate | fullscreen | alert]
        - [OPEN_APP: chrome | spotify | calc] (Works if Olivia is running locally)
        - [SMART_HOME: on/off] (Controls Sir's Sonoff Light)
        - [BOOK_APPT: Name | Date | Time | Service]
        
        CONTEXT FROM RECENT WHATSAPP LEADS:
        ${leadsSummary || "No active leads."}

        ${memoryContext}
        
        PHILOSOPHY: Be proactive like Siri. If Sir says "I'm hungry", suggest his favorites and offer restaurants. If he says "I'm tired", check his calendar.
        
        CRITICAL: 
        - ALWAYS provide a natural Singlish reply FIRST, then include the tool tag.
        - NEVER output only a tag.
        - NEVER say you cannot do something that has a tool tag above.
        - If Sir uses Sinhala characters, respond in formal Sinhala (සිංහල).
        `;

        const systemPrompt = customSystem ? decodeURIComponent(customSystem) : internalSystem;

        let history = [];
        if (historyRaw) {
            try { 
                const parsed = JSON.parse(decodeURIComponent(historyRaw));
                history = parsed.slice(-10).map(h => ({
                    role: h.role === 'ai' || h.role === 'model' ? 'assistant' : 'user',
                    content: h.text || ""
                }));
            } catch (e) { console.error('History parse error:', e); }
        }

        let answer = "";

        // Model Routing Logic
        if (modelType === "gemini" && genAI) {
            try {
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
            } catch (e) { console.warn("Gemini failing, falling back...", e.message); }
        } 
        
        if (!answer && modelType === "chatgpt" && openai) {
            try {
                const completion = await openai.chat.completions.create({
                    model: "gpt-4o",
                    messages: [
                        { role: "system", content: systemPrompt },
                        ...history,
                        { role: "user", content: query }
                    ],
                });
                answer = completion.choices[0].message.content;
            } catch (e) { console.warn("ChatGPT failing, falling back...", e.message); }
        } 
        
        // Final Fallback to Groq Llama 3.3
        if (!answer) {
            if (!groq) throw new Error('Groq client not initialized.');
            const chatCompletion = await groq.chat.completions.create({
                messages: [
                    { role: "system", content: systemPrompt },
                    ...history,
                    { role: "user", content: query }
                ],
                model: "llama-3.3-70b-versatile",
                temperature: 0.7,
                max_tokens: 1024,
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
            voice: voiceId || "bMxLr8fP6hzNRRi9nJxU", // Default requested by user
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

// --- REMINDER CHECKER JOB ---
cron.schedule('* * * * *', () => { // Every minute
    const now = new Date();
    let changed = false;
    reminders.forEach(r => {
        if (!r.sent) {
            const rTime = new Date(r.time);
            if (rTime <= now) {
                console.log(`⏰ REMINDER TRIGGERED: ${r.msg}`);
                sendPushToAll("Olivia Reminder ⏰", r.msg).catch(e => {});
                r.sent = true;
                changed = true;
            }
        }
    });
    if (changed) saveData(remindersFile, reminders);
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
            
            // --- PUSH ALERT ---
            sendPushToAll(`New Message from ${from.split('@')[0]}`, body.substring(0, 50) + (body.length > 50 ? '...' : ''));

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
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- SERVER STARTUP ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Olivia Core Elite v8.3 running on port ${PORT}`);
    
    // --- DIAGNOSTICS ---
    console.log('📊 Environment Status:');
    console.log(`  - GROQ_API_KEY: ${process.env.GROQ_API_KEY ? '✅ set' : '❌ missing'}`);
    console.log(`  - GEMINI_API_KEY: ${process.env.GEMINI_API_KEY ? '✅ set' : '❌ missing'}`);
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
