import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { GoogleGenerativeAI } from '@google/generative-ai';
import qrImage from 'qr-image';
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import http from 'http';
import { fileURLToPath } from 'url';

// Force Sri Lanka Timezone (Asia/Colombo) for all date operations
process.env.TZ = 'Asia/Colombo';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authFolder = path.join(__dirname, 'auth_info_baileys');
const remindersFile = path.join(__dirname, 'reminders.json');
const blockedFile = path.join(__dirname, 'blocked.json');
const notesFile = path.join(__dirname, 'notes.json');

// --- Settings from .env ---
const BOT_NAME = process.env.BOT_NAME || 'Olivia';
const OWNER_NAME = process.env.OWNER_NAME || 'Subhash';
const MY_WEBSITE = process.env.MY_WEBSITE || 'https://69studiobysubash.online/';
const OWNER_NUMBER = (process.env.OWNER_NUMBER || '').replace(/[^0-9]/g, '');
const COOLDOWN_MINUTES = parseInt(process.env.COOLDOWN_MINUTES || '10', 10);
const USE_AI = process.env.USE_AI === 'true' && !!process.env.GEMINI_API_KEY;
const PORT = process.env.PORT || 3000;

/**
 * Format any date cleanly in Sri Lanka Time (Asia/Colombo)
 */
function formatSLTime(date) {
    if (!date) return '';
    return new Date(date).toLocaleString('en-US', {
        timeZone: 'Asia/Colombo',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        hour12: true
    });
}

// --- Auto-Restore Session from Environment Variable (for 24/7 Cloud Hosting) ---
if (process.env.SESSION_DATA && (!fs.existsSync(authFolder) || fs.readdirSync(authFolder).length === 0)) {
    try {
        console.log('📦 Restoring WhatsApp session from SESSION_DATA environment variable...');
        if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });
        const buf = Buffer.from(process.env.SESSION_DATA, 'base64');
        const jsonString = zlib.gunzipSync(buf).toString('utf8');
        const bundle = JSON.parse(jsonString);

        for (const [filename, content] of Object.entries(bundle)) {
            fs.writeFileSync(path.join(authFolder, filename), content);
        }
        console.log('✅ WhatsApp session restored successfully from cloud environment!');
    } catch (err) {
        console.error('❌ Failed to unpack SESSION_DATA:', err.message);
    }
}

// Global Bot Status & State
let currentStatus = 'initializing';
let lastQR = null;
let currentSock = null; // Global Baileys socket reference for scheduler
const lastReplyMap = new Map();
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Optional Gemini AI Init
let genAI = null;
if (USE_AI) {
    try {
        genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        console.log(`🤖 ${BOT_NAME} AI Smart Auto-Reply Mode: ENABLED (Gemini)`);
    } catch (e) {
        console.warn('⚠️ Gemini Init Failed, falling back to Standard Busy Auto-Reply:', e.message);
    }
} else {
    console.log(`⚡ ${BOT_NAME} Direct Busy Auto-Reply Mode: ACTIVE`);
}

// --- Reminders Database Helpers ---
function loadReminders() {
    try {
        if (fs.existsSync(remindersFile)) {
            return JSON.parse(fs.readFileSync(remindersFile, 'utf8'));
        }
    } catch (e) {
        console.error('Error loading reminders:', e.message);
    }
    return [];
}

function saveReminders(reminders) {
    try {
        fs.writeFileSync(remindersFile, JSON.stringify(reminders, null, 2));
    } catch (e) {
        console.error('Error saving reminders:', e.message);
    }
}

// --- Blocked Contacts Helpers ---
function loadBlocked() {
    try {
        if (fs.existsSync(blockedFile)) {
            return JSON.parse(fs.readFileSync(blockedFile, 'utf8'));
        }
    } catch (e) {
        console.error('Error loading blocked list:', e.message);
    }
    return [];
}

function saveBlocked(blocked) {
    try {
        fs.writeFileSync(blockedFile, JSON.stringify(blocked, null, 2));
    } catch (e) {
        console.error('Error saving blocked list:', e.message);
    }
}

function isBlocked(phoneNumber) {
    const blocked = loadBlocked();
    const sanitized = sanitizePhoneNumber(phoneNumber);
    return blocked.some(b => b === sanitized || b === phoneNumber);
}

// --- Client Notes Helpers ---
function loadNotes() {
    try {
        if (fs.existsSync(notesFile)) {
            return JSON.parse(fs.readFileSync(notesFile, 'utf8'));
        }
    } catch (e) {
        console.error('Error loading notes:', e.message);
    }
    return {};
}

function saveNotes(notes) {
    try {
        fs.writeFileSync(notesFile, JSON.stringify(notes, null, 2));
    } catch (e) {
        console.error('Error saving notes:', e.message);
    }
}

// --- Notification Tracking (in-memory for dashboard SSE) ---
let recentNotifications = [];
function addNotification(type, message) {
    recentNotifications.push({
        id: 'notif_' + Date.now(),
        type,
        message,
        time: new Date().toISOString(),
        read: false
    });
    // Keep only last 50
    if (recentNotifications.length > 50) {
        recentNotifications = recentNotifications.slice(-50);
    }
}

/**
 * Format phone number into standard international format (e.g. 947XXXXXXXX)
 */
function sanitizePhoneNumber(input) {
    let num = (input || '').replace(/[^0-9]/g, '');
    if (num.startsWith('0') && num.length === 10) {
        num = '94' + num.substring(1);
    } else if (num.length === 9) {
        num = '94' + num;
    }
    return num;
}

/**
 * Parses flexible date & time input
 * Supports: "2h", "30m", "1d", "tomorrow 10:00", "today 18:00", "YYYY-MM-DD HH:mm"
 */
function parseScheduledTime(timeStr) {
    if (!timeStr) return null;
    const s = timeStr.trim().toLowerCase();
    const now = new Date();

    // Relative minutes (e.g., 30m, 15min)
    const minMatch = s.match(/^(\d+)\s*(m|min|mins|minute|minutes)$/);
    if (minMatch) {
        return new Date(now.getTime() + parseInt(minMatch[1], 10) * 60 * 1000);
    }

    // Relative hours (e.g., 2h, 3hr, 1 hour)
    const hrMatch = s.match(/^(\d+)\s*(h|hr|hrs|hour|hours)$/);
    if (hrMatch) {
        return new Date(now.getTime() + parseInt(hrMatch[1], 10) * 60 * 60 * 1000);
    }

    // Relative days (e.g., 1d, 2 days)
    const dayMatch = s.match(/^(\d+)\s*(d|day|days)$/);
    if (dayMatch) {
        return new Date(now.getTime() + parseInt(dayMatch[1], 10) * 24 * 60 * 60 * 1000);
    }

    // "tomorrow HH:mm"
    const tomorrowMatch = s.match(/^tomorrow\s+(\d{1,2}):(\d{2})$/);
    if (tomorrowMatch) {
        const d = new Date(now);
        d.setDate(d.getDate() + 1);
        d.setHours(parseInt(tomorrowMatch[1], 10), parseInt(tomorrowMatch[2], 10), 0, 0);
        return d;
    }

    // "today HH:mm"
    const todayMatch = s.match(/^today\s+(\d{1,2}):(\d{2})$/);
    if (todayMatch) {
        const d = new Date(now);
        d.setHours(parseInt(todayMatch[1], 10), parseInt(todayMatch[2], 10), 0, 0);
        return d;
    }

    // "HH:mm" (e.g. "14:30" or "10:00")
    const timeOnlyMatch = s.match(/^(\d{1,2}):(\d{2})$/);
    if (timeOnlyMatch) {
        const d = new Date(now);
        d.setHours(parseInt(timeOnlyMatch[1], 10), parseInt(timeOnlyMatch[2], 10), 0, 0);
        if (d.getTime() <= now.getTime()) {
            d.setDate(d.getDate() + 1); // If time has passed today, schedule for tomorrow
        }
        return d;
    }

    // Standard date string (e.g. "2026-09-15 10:30" or "2026-09-15T10:30")
    const parsed = new Date(s.replace(' ', 'T'));
    if (!isNaN(parsed.getTime())) {
        return parsed;
    }

    return null;
}

/**
 * Standard friendly busy message
 */
function getBusyMessage(senderName) {
    const greeting = senderName ? `Hello ${senderName}! 👋` : `Hello! 👋`;

    if (process.env.CUSTOM_BUSY_MESSAGE) {
        return process.env.CUSTOM_BUSY_MESSAGE
            .replace('{name}', senderName || '')
            .replace('{bot}', BOT_NAME)
            .replace('{owner}', OWNER_NAME)
            .replace('{website}', MY_WEBSITE);
    }

    return `${greeting}\n\nI am ${BOT_NAME}, ${OWNER_NAME}'s personal AI assistant. ${OWNER_NAME} is currently busy at the moment.\n\nIf you have any message or need anything, please leave it here and ${OWNER_NAME} will get back to you as soon as he is free! ✍️\n\n🌐 In the meantime, feel free to check out his website:\n${MY_WEBSITE}`;
}

/**
 * AI Smart reply if Gemini is enabled
 */
async function getSmartAIReply(userText, senderName) {
    if (!genAI) return getBusyMessage(senderName);

    try {
        const systemPrompt = `You are ${BOT_NAME}, the personal AI assistant for ${OWNER_NAME}.
The user is messaging ${OWNER_NAME}'s personal WhatsApp.
YOUR PRIMARY TASK:
1. Politely introduce yourself as ${BOT_NAME}, ${OWNER_NAME}'s personal AI assistant, and inform them that ${OWNER_NAME} is currently busy.
2. Tell them that if they have anything to tell him or need help with, they should leave their message here, and ${OWNER_NAME} will get back to them as soon as he is free.
3. Always share ${OWNER_NAME}'s website: ${MY_WEBSITE}
4. Speak naturally in Singlish if they text in Singlish/Sinhala (e.g., "${OWNER_NAME} me welawe poddak busy mchn..."), or friendly English if they text in English.
5. Keep it short, warm, and conversational. Do not write essays.`;

        const model = genAI.getGenerativeModel({
            model: 'gemini-3.6-flash',
            systemInstruction: systemPrompt
        });

        const result = await model.generateContent(userText);
        return result.response.text().trim();
    } catch (e) {
        console.warn('AI reply failed, using standard message:', e.message);
        return getBusyMessage(senderName);
    }
}

/**
 * Schedule Reminder Engine: checks every 20 seconds
 */
setInterval(async () => {
    if (!currentSock || currentStatus !== 'connected') return;

    const reminders = loadReminders();
    if (!reminders || reminders.length === 0) return;

    const now = new Date();
    let updated = false;

    for (const rem of reminders) {
        if (rem.status === 'pending') {
            const scheduled = new Date(rem.time);

            if (now >= scheduled) {
                console.log(`⏰ Firing scheduled reminder for +${rem.phone}...`);
                rem.status = 'sending';

                try {
                    const recipientJid = `${rem.phone}@s.whatsapp.net`;
                    await currentSock.sendMessage(recipientJid, { text: rem.message });
                    rem.status = 'sent';
                    rem.sentAt = new Date().toISOString();
                    updated = true;
                    console.log(`✅ Scheduled payment reminder delivered to +${rem.phone}!`);

                    // Add dashboard notification
                    addNotification('reminder_sent', `Payment reminder delivered to +${rem.phone}`);

                    // Notify Subhash (Owner)
                    const ownerJid = OWNER_NUMBER 
                        ? `${OWNER_NUMBER}@s.whatsapp.net` 
                        : (currentSock.user?.id ? currentSock.user.id.split(':')[0] + '@s.whatsapp.net' : null);

                    if (ownerJid) {
                        const confirmMsg = `🔔 *[Auto-Reminder Sent]*\n\n` +
                                           `✅ Payment reminder successfully delivered to: *+${rem.phone}*\n` +
                                           `💬 *Message:* "${rem.message}"\n` +
                                           `⏱️ *Time:* ${formatSLTime(new Date())}`;
                        await currentSock.sendMessage(ownerJid, { text: confirmMsg });
                    }
                } catch (sendErr) {
                    console.error(`❌ Failed to send scheduled reminder to ${rem.phone}:`, sendErr.message);
                    rem.status = 'failed';
                    rem.error = sendErr.message;
                    updated = true;
                }
            }
        }
    }

    if (updated) {
        saveReminders(reminders);
    }
}, 20000); // Check every 20s

/**
 * Helper to parse POST body
 */
function getJsonBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch (e) { resolve({}); }
        });
    });
}

/**
 * Lightweight HTTP Server for Cloud Hosting & Reminder Dashboard
 */
const server = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];

    // API: Health Check
    if (url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'ok', uptime: Math.floor(process.uptime()), bot: BOT_NAME }));
    }

    // API: Get Reminders
    if (url === '/api/reminders' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(loadReminders()));
    }

    // API: Schedule Reminder from Web Form
    if (url === '/api/reminders' && req.method === 'POST') {
        const body = await getJsonBody(req);
        const phone = sanitizePhoneNumber(body.phone);
        const scheduledTime = parseScheduledTime(body.time);

        if (!phone || phone.length < 9) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Invalid phone number.' }));
        }

        if (!scheduledTime || scheduledTime.getTime() <= Date.now()) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Please specify a valid future date/time.' }));
        }

        if (!body.message || body.message.trim().length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Message cannot be empty.' }));
        }

        const newReminder = {
            id: 'rem_' + Date.now(),
            phone,
            time: scheduledTime.toISOString(),
            message: body.message.trim(),
            status: 'pending',
            createdAt: new Date().toISOString()
        };

        const reminders = loadReminders();
        reminders.push(newReminder);
        saveReminders(reminders);

        console.log(`📅 Web UI Scheduled Reminder for +${phone} at ${formatSLTime(scheduledTime)}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, reminder: newReminder }));
    }

    // API: Delete / Cancel Reminder
    if (url === '/api/reminders/delete' && req.method === 'POST') {
        const body = await getJsonBody(req);
        let reminders = loadReminders();
        reminders = reminders.filter(r => r.id !== body.id);
        saveReminders(reminders);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true }));
    }

    // API: Clear Sent History
    if (url === '/api/reminders/clear-history' && req.method === 'POST') {
        let reminders = loadReminders();
        reminders = reminders.filter(r => r.status === 'pending');
        saveReminders(reminders);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true }));
    }

    // API: Send Now (Quick Direct Message from Dashboard)
    if (url === '/api/send-now' && req.method === 'POST') {
        const body = await getJsonBody(req);
        const phone = sanitizePhoneNumber(body.phone);

        if (!phone || phone.length < 9) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Invalid phone number.' }));
        }

        if (!body.message || body.message.trim().length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Message cannot be empty.' }));
        }

        if (!currentSock || currentStatus !== 'connected') {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'WhatsApp is not connected.' }));
        }

        try {
            const recipientJid = `${phone}@s.whatsapp.net`;
            await currentSock.sendMessage(recipientJid, { text: body.message.trim() });
            console.log(`⚡ Quick Send from Dashboard to +${phone}`);

            addNotification('send', `Message sent to +${phone}`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, phone }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Failed to send: ' + e.message }));
        }
    }

    // API: Get Contacts (Contact Book)
    if (url === '/api/contacts' && req.method === 'GET') {
        const reminders = loadReminders();
        const notes = loadNotes();
        const blocked = loadBlocked();
        const contactMap = {};

        for (const rem of reminders) {
            if (!contactMap[rem.phone]) {
                contactMap[rem.phone] = { phone: rem.phone, totalReminders: 0, lastContact: null, sentCount: 0, pendingCount: 0 };
            }
            contactMap[rem.phone].totalReminders++;
            if (rem.status === 'sent') contactMap[rem.phone].sentCount++;
            if (rem.status === 'pending') contactMap[rem.phone].pendingCount++;

            const remTime = new Date(rem.sentAt || rem.time);
            if (!contactMap[rem.phone].lastContact || remTime > new Date(contactMap[rem.phone].lastContact)) {
                contactMap[rem.phone].lastContact = remTime.toISOString();
            }
        }

        const contacts = Object.values(contactMap).map(c => ({
            ...c,
            notes: (notes[c.phone] || []).length,
            isBlocked: blocked.includes(c.phone)
        }));

        contacts.sort((a, b) => new Date(b.lastContact || 0) - new Date(a.lastContact || 0));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(contacts));
    }

    // API: Analytics
    if (url === '/api/analytics' && req.method === 'GET') {
        const reminders = loadReminders();
        const totalSent = reminders.filter(r => r.status === 'sent').length;
        const totalFailed = reminders.filter(r => r.status === 'failed').length;
        const totalPending = reminders.filter(r => r.status === 'pending').length;
        const uniqueContacts = [...new Set(reminders.map(r => r.phone))].length;
        const successRate = (totalSent + totalFailed) > 0 ? Math.round((totalSent / (totalSent + totalFailed)) * 100) : 0;

        // Daily counts for last 7 days
        const dailyCounts = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dayStr = d.toISOString().split('T')[0];
            const count = reminders.filter(r => {
                const rDate = (r.sentAt || r.createdAt || r.time || '').split('T')[0];
                return rDate === dayStr && (r.status === 'sent' || r.status === 'failed');
            }).length;
            dailyCounts.push({ date: dayStr, day: d.toLocaleDateString('en-US', { weekday: 'short' }), count });
        }

        // Top 5 contacts
        const phoneCount = {};
        reminders.forEach(r => { phoneCount[r.phone] = (phoneCount[r.phone] || 0) + 1; });
        const topContacts = Object.entries(phoneCount)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([phone, count]) => ({ phone, count }));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            totalSent, totalFailed, totalPending, uniqueContacts, successRate,
            dailyCounts, topContacts,
            uptime: Math.floor(process.uptime()),
            botStatus: currentStatus
        }));
    }

    // API: Notifications (for browser push)
    if (url === '/api/notifications' && req.method === 'GET') {
        const unread = recentNotifications.filter(n => !n.read);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ notifications: unread, count: unread.length }));
    }

    // API: Mark Notifications as Read
    if (url === '/api/notifications/read' && req.method === 'POST') {
        recentNotifications.forEach(n => { n.read = true; });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true }));
    }

    // API: Get Notes for a Phone
    if (url.startsWith('/api/notes/') && req.method === 'GET') {
        const phone = sanitizePhoneNumber(url.split('/api/notes/')[1] || '');
        const notes = loadNotes();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(notes[phone] || []));
    }

    // QR Code Image Route
    if (url === '/qr') {
        if (!lastQR) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(`<h2>✅ WhatsApp is already connected! No QR code needed.</h2><p><a href="/">Back to Dashboard</a></p>`);
        }
        res.writeHead(200, { 'Content-Type': 'image/png' });
        const qrStream = qrImage.image(lastQR, { type: 'png', size: 8 });
        return qrStream.pipe(res);
    }

    // Full Web Dashboard with Schedule Reminder Form
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const uptimeMin = Math.floor(process.uptime() / 60);
    const reminders = loadReminders();
    const pendingReminders = reminders.filter(r => r.status === 'pending');
    const sentReminders = reminders.filter(r => r.status === 'sent' || r.status === 'failed').reverse();

    const reminderTemplates = {
        friendly: `Hi, this is Olivia, the AI Assistant from 69 Studio. 😊\n\nJust a friendly reminder regarding your outstanding payment of Rs. [AMOUNT].\n\nPlease settle the payment at your earliest convenience. Thank you for your continued support! 🙏\n\nBest regards,\nOlivia | 69 Studio`,
        advance: `Hi! This is Olivia from 69 Studio. 📸\n\nTo confirm and lock in your project/booking date, kindly deposit the advance payment of Rs. [AMOUNT].\n\nPlease share the payment slip or transaction screenshot once done. Thank you! 🙏\n\nBest regards,\nOlivia | 69 Studio`,
        delivery: `Hello! Great news — your project files from 69 Studio are ready for delivery! 🎨\n\nKindly settle the final balance of Rs. [AMOUNT] so we can share the high-resolution download link immediately.\n\nThank you,\n69 Studio`,
        bank: `Hello! Here are the official payment transfer details for 69 Studio:\n\n🏦 Bank: SAMPATH BANK PLC\n💳 Account Name: K S SALIYA\n🔢 Account No: 1122 5249 1630\n📍 Branch: RAJAGIRIYA BRANCH\n\nPlease share a screenshot of the deposit slip once transferred. Thank you! 🙏`,
        urgent: `Hello! This is an urgent follow-up reminder from 69 Studio regarding the pending payment of Rs. [AMOUNT] which is now overdue.\n\nIf you have already settled this, please share the transaction receipt with Subhash. Thank you for your prompt attention.`,
        thankyou: `Hi! This is Olivia from 69 Studio. 🙏\n\nThank you so much for your payment of Rs. [AMOUNT]! We truly appreciate your trust and support.\n\nYour project is in great hands, and we'll keep you updated on the progress. Feel free to reach out anytime!\n\nBest regards,\nOlivia | 69 Studio`,
        followup: `Hi! This is Olivia from 69 Studio. 📞\n\nJust following up on our recent conversation. We wanted to check if you had any questions or if you'd like to proceed with the project.\n\nFeel free to reply here or contact Subhash directly. We'd love to work with you!\n\nBest regards,\nOlivia | 69 Studio`,
        appointment: `Hi! This is Olivia from 69 Studio. 📅\n\nFriendly reminder about your upcoming appointment/session with 69 Studio on [DATE] at [TIME].\n\nPlease confirm your availability or let us know if you need to reschedule.\n\nLooking forward to seeing you! 😊\nOlivia | 69 Studio`,
        quotation: `Hi! This is Olivia from 69 Studio. 📋\n\nHere's the quotation for your requested project:\n\n🎯 Project: [PROJECT NAME]\n💰 Total: Rs. [AMOUNT]\n📅 Timeline: [DURATION]\n\nThis quote is valid for 7 days. To confirm, please deposit the advance payment of Rs. [ADVANCE].\n\nFeel free to ask any questions!\nOlivia | 69 Studio`,
        welcome: `Welcome to 69 Studio! 👋🎨\n\nI'm Olivia, the AI assistant for Subhash at 69 Studio. We specialize in creative design, photography, and digital solutions.\n\nFeel free to share your project idea, and we'll get back to you with a custom quote!\n\n🌐 Visit us: ${MY_WEBSITE}\n\nBest regards,\nOlivia | 69 Studio`,
        review: `Hi! This is Olivia from 69 Studio. ⭐\n\nWe hope you're happy with the work from 69 Studio! Your feedback means the world to us.\n\nWould you mind leaving a quick review? It helps us grow and serve you even better! 🙏\n\n⭐ Leave a review: [REVIEW LINK]\n\nThank you for choosing 69 Studio!\nOlivia | 69 Studio`
    };

    const html = `<!DOCTYPE html>
<html>
<head>
    <title>${BOT_NAME} - 24/7 Cloud Assistant & Reminders</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b141a; color: #e9edef; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px 0; }
        .card { background: #111b21; border-radius: 16px; padding: 28px; max-width: 520px; width: 90%; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border: 1px solid #222e35; }
        .badge { display: inline-block; padding: 6px 14px; border-radius: 20px; font-weight: 600; font-size: 14px; margin-bottom: 12px; background: #00a884; color: #fff; }
        h1 { margin: 0 0 6px 0; font-size: 24px; color: #00a884; }
        h2 { margin: 20px 0 10px 0; font-size: 18px; color: #53bdeb; border-top: 1px solid #222e35; padding-top: 18px; }
        p { color: #8696a0; margin: 6px 0; font-size: 14px; }
        a { color: #53bdeb; text-decoration: none; font-weight: 500; }
        .qr-box { margin-top: 16px; background: #fff; padding: 12px; border-radius: 12px; display: inline-block; }
        
        /* Form styling */
        label { display: block; font-size: 13px; color: #8696a0; margin-top: 12px; text-align: left; }
        input, select, textarea { width: 100%; box-sizing: border-box; background: #202c33; border: 1px solid #2a3942; border-radius: 8px; padding: 10px; color: #e9edef; font-size: 14px; margin-top: 4px; }
        select { cursor: pointer; }
        input[type="datetime-local"] { color-scheme: dark; cursor: pointer; }
        input:focus, select:focus, textarea:focus { outline: none; border-color: #00a884; }
        button { background: #00a884; color: #111; font-weight: 600; border: none; padding: 12px 20px; border-radius: 8px; cursor: pointer; width: 100%; margin-top: 16px; font-size: 15px; }
        button:hover { background: #06cf9c; }
        
        .preset-btn {
            background: #202c33;
            color: #8696a0;
            border: 1px solid #2a3942;
            padding: 5px 10px;
            border-radius: 6px;
            font-size: 12px;
            cursor: pointer;
            width: auto;
            margin-top: 0;
            transition: all 0.2s;
        }
        .preset-btn:hover {
            background: #2a3942;
            color: #00a884;
            border-color: #00a884;
        }
        
        .tabs-header {
            display: flex;
            border-bottom: 1px solid #222e35;
            margin-top: 24px;
            margin-bottom: 14px;
            gap: 4px;
        }
        .tab-btn {
            background: transparent;
            color: #8696a0;
            border: none;
            border-bottom: 2px solid transparent;
            padding: 10px 14px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 600;
            width: auto;
            margin-top: 0;
            border-radius: 0;
            transition: all 0.2s;
        }
        .tab-btn:hover {
            color: #e9edef;
            background: rgba(255,255,255,0.03);
        }
        .tab-btn.active {
            color: #00a884;
            border-bottom: 2px solid #00a884;
        }

        .rem-item { background: #202c33; border-radius: 8px; padding: 12px 14px; margin-top: 8px; text-align: left; font-size: 13px; border-left: 3px solid #00a884; display: flex; justify-content: space-between; align-items: center; }
        .rem-item.sent-item { border-left: 3px solid #53bdeb; }
        .del-btn { background: #ea4335; color: #fff; border: none; border-radius: 4px; padding: 6px 10px; cursor: pointer; font-size: 12px; width: auto; margin-top: 0; }
        .del-btn:hover { background: #d93025; }
        .clear-btn { background: transparent; border: 1px solid #ea4335; color: #ea4335; border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px; width: auto; margin: 0; transition: all 0.2s; }
        .clear-btn:hover { background: #ea4335; color: #fff; }
        
        input[type="datetime-local"]::-webkit-calendar-picker-indicator { filter: invert(0.8); cursor: pointer; font-size: 16px; }
        .countdown-badge {
            background: rgba(0, 168, 132, 0.15);
            color: #00a884;
            border: 1px solid #00a884;
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 600;
            font-family: monospace;
            display: inline-block;
            white-space: nowrap;
        }
        .countdown-badge.expired {
            background: rgba(234, 67, 53, 0.15);
            color: #ea4335;
            border-color: #ea4335;
        }
        .status-badge {
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 600;
            display: inline-block;
            white-space: nowrap;
        }
        .status-badge.sent {
            background: rgba(0, 168, 132, 0.15);
            color: #00a884;
            border: 1px solid #00a884;
        }
        .status-badge.failed {
            background: rgba(234, 67, 53, 0.15);
            color: #ea4335;
            border: 1px solid #ea4335;
        }

        /* Analytics Cards */
        .analytics-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
            gap: 10px;
            margin: 12px 0;
        }
        .stat-card {
            background: #202c33;
            border-radius: 10px;
            padding: 14px 10px;
            text-align: center;
            border: 1px solid #2a3942;
            transition: transform 0.2s, border-color 0.2s;
        }
        .stat-card:hover {
            transform: translateY(-2px);
            border-color: #00a884;
        }
        .stat-card .stat-num {
            font-size: 24px;
            font-weight: 700;
            color: #00a884;
            display: block;
        }
        .stat-card .stat-label {
            font-size: 11px;
            color: #8696a0;
            margin-top: 4px;
            display: block;
        }
        .chart-bar-container {
            display: flex;
            align-items: flex-end;
            gap: 6px;
            height: 80px;
            margin: 14px 0 6px 0;
            padding: 0 4px;
        }
        .chart-bar-wrapper {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            height: 100%;
            justify-content: flex-end;
        }
        .chart-bar {
            width: 100%;
            background: linear-gradient(180deg, #00a884, #065f46);
            border-radius: 4px 4px 0 0;
            min-height: 4px;
            transition: height 0.5s ease;
        }
        .chart-bar-label {
            font-size: 10px;
            color: #8696a0;
            margin-top: 4px;
            text-align: center;
        }
        .chart-bar-count {
            font-size: 10px;
            color: #00a884;
            font-weight: 600;
            margin-bottom: 2px;
        }

        /* Quick Send */
        .quick-send-form {
            background: #202c33;
            border-radius: 10px;
            padding: 16px;
            margin-top: 12px;
            border: 1px solid #2a3942;
        }
        .quick-send-form label {
            margin-top: 8px;
        }
        .quick-send-form label:first-child {
            margin-top: 0;
        }
        .send-now-btn {
            background: #53bdeb;
            color: #111;
        }
        .send-now-btn:hover {
            background: #3eaadb;
        }

        /* Contact Book */
        .contact-item {
            background: #202c33;
            border-radius: 8px;
            padding: 12px 14px;
            margin-top: 8px;
            text-align: left;
            font-size: 13px;
            border-left: 3px solid #53bdeb;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .contact-actions {
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
        }
        .contact-actions button {
            width: auto;
            margin: 0;
            padding: 4px 8px;
            font-size: 11px;
            border-radius: 4px;
        }

        /* Toast Notification */
        .toast {
            position: fixed;
            top: 16px;
            right: 16px;
            background: #00a884;
            color: #111;
            padding: 12px 20px;
            border-radius: 10px;
            font-weight: 600;
            font-size: 14px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.4);
            z-index: 9999;
            transform: translateX(120%);
            transition: transform 0.4s ease;
        }
        .toast.show {
            transform: translateX(0);
        }
        .notif-bell {
            position: relative;
            cursor: pointer;
            font-size: 18px;
            display: inline-block;
        }
        .notif-count {
            position: absolute;
            top: -6px;
            right: -8px;
            background: #ea4335;
            color: #fff;
            font-size: 10px;
            font-weight: 700;
            padding: 1px 5px;
            border-radius: 10px;
            display: none;
        }
    </style>
</head>
<body>
    <div class="card">
        <div style="text-align: center;">
            <div style="display: flex; justify-content: center; align-items: center; gap: 10px;">
                <span class="badge">${currentStatus === 'connected' ? '🟢 ONLINE 24/7' : '🟡 ' + currentStatus.toUpperCase()}</span>
                <span class="notif-bell" id="notifBell" onclick="checkNotifications()">🔔<span class="notif-count" id="notifCount">0</span></span>
            </div>
            <h1>🤖 ${BOT_NAME}</h1>
            <p>Personal Assistant for <strong>${OWNER_NAME}</strong> | Uptime: <strong>${uptimeMin} mins</strong></p>
            <p>🌐 Website: <a href="${MY_WEBSITE}" target="_blank">${MY_WEBSITE}</a></p>
            ${lastQR ? '<div class="qr-box"><img src="/qr" alt="QR Code" width="200"><p style="color:#111;margin:6px 0 0 0;font-size:12px;">Scan with WhatsApp</p></div>' : ''}
        </div>

        <!-- Analytics Section -->
        <h2>📊 Analytics Overview</h2>
        <div class="analytics-grid">
            <div class="stat-card">
                <span class="stat-num" id="statPending">${pendingReminders.length}</span>
                <span class="stat-label">⏳ Pending</span>
            </div>
            <div class="stat-card">
                <span class="stat-num" id="statSent">${sentReminders.filter(r => r.status === 'sent').length}</span>
                <span class="stat-label">✅ Sent</span>
            </div>
            <div class="stat-card">
                <span class="stat-num" id="statFailed">${sentReminders.filter(r => r.status === 'failed').length}</span>
                <span class="stat-label">❌ Failed</span>
            </div>
            <div class="stat-card">
                <span class="stat-num" id="statContacts">${[...new Set(reminders.map(r => r.phone))].length}</span>
                <span class="stat-label">👥 Contacts</span>
            </div>
        </div>
        <div id="chartArea" style="background: #202c33; border-radius: 10px; padding: 12px; margin-top: 8px; border: 1px solid #2a3942;">
            <p style="font-size: 12px; color: #8696a0; margin: 0 0 4px 0;">Last 7 Days Activity:</p>
            <div class="chart-bar-container" id="barChart">Loading...</div>
        </div>

        <h2>📅 Schedule Payment Auto-Reminder</h2>
        <form id="remForm">
            <label>Client Phone Number:</label>
            <input type="text" id="remPhone" placeholder="e.g. 0771234567 or 94771234567" required>

            <label>📅 Pick Date & Time from Calendar (Click to open):</label>
            <input type="datetime-local" id="remTime" required onclick="try{this.showPicker()}catch(e){}">
            <div style="display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap;">
                <button type="button" class="preset-btn" onclick="setPreset(15)">+15m</button>
                <button type="button" class="preset-btn" onclick="setPreset(60)">+1 Hour</button>
                <button type="button" class="preset-btn" onclick="setPreset(180)">+3 Hours</button>
                <button type="button" class="preset-btn" onclick="setTomorrow(10, 0)">Tomorrow 10 AM</button>
                <button type="button" class="preset-btn" onclick="setTomorrow(14, 0)">Tomorrow 2 PM</button>
                <button type="button" class="preset-btn" onclick="setDaysAhead(2, 10, 0)">In 2 Days (10 AM)</button>
                <button type="button" class="preset-btn" onclick="setDaysAhead(7, 10, 0)">In 1 Wk (10 AM)</button>
            </div>

            <label style="margin-top: 14px;">⚡ Quick Message Template (Optional):</label>
            <select id="templateSelect" onchange="applyTemplate(this.value)">
                <option value="">-- Choose a Pre-made Template or Type Below --</option>
                <option value="friendly">💵 Friendly Payment Reminder (සාමාන්‍ය Payment)</option>
                <option value="advance">📸 Advance / Booking Confirmation (Advance මුදල්)</option>
                <option value="delivery">🎨 Project Ready / Final Balance (වැඩ නිමවීම & Balance)</option>
                <option value="bank">🏦 Bank Account & Transfer Details (බැංකු විස්තර)</option>
                <option value="urgent">⚠️ Overdue Urgent Reminder (පරක්කු වූ Payment)</option>
                <option value="thankyou">🙏 Thank You for Payment (ගෙවීම් ස්තුතිය)</option>
                <option value="followup">📞 Follow-Up Reminder (Follow-Up)</option>
                <option value="appointment">📅 Appointment Reminder (හමුවීම් මතක්)</option>
                <option value="quotation">📋 Quotation / Price Quote (මිල ගණන්)</option>
                <option value="welcome">👋 Welcome New Client (නව Client)</option>
                <option value="review">⭐ Review Request (ප්‍රතිපෝෂණ)</option>
            </select>

            <label style="margin-top: 14px;">Reminder Message:</label>
            <textarea id="remMsg" rows="4" placeholder="Hello! Friendly payment reminder regarding 69 Studio for Rs. 15,000..." required></textarea>

            <button type="submit">Schedule Reminder 🚀</button>
        </form>

        <div class="tabs-header">
            <button type="button" id="tabPendingBtn" onclick="switchTab('pending')" class="tab-btn active">
                📋 Pending (${pendingReminders.length})
            </button>
            <button type="button" id="tabHistoryBtn" onclick="switchTab('history')" class="tab-btn">
                📜 Sent History (${sentReminders.length})
            </button>
        </div>

        <div id="pendingTabContent">
            ${pendingReminders.length === 0 ? '<p style="text-align:center; padding: 14px 0;">No pending reminders right now.</p>' : 
                pendingReminders.map(r => `
                    <div class="rem-item">
                        <div style="flex: 1;">
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                                <strong>+${r.phone}</strong>
                                <span class="countdown-badge" data-target="${r.time}">⏳ Calculating...</span>
                            </div>
                            <em style="color:#8696a0; font-size: 12px;">📅 ${formatSLTime(r.time)}</em><br>
                            <span style="color:#e9edef; margin-top: 4px; display: inline-block;">"${r.message}"</span>
                        </div>
                        <button class="del-btn" style="margin-left: 12px;" onclick="cancelRem('${r.id}')">Cancel</button>
                    </div>
                `).join('')}
        </div>

        <div id="historyTabContent" style="display: none;">
            ${sentReminders.length > 0 ? `
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                    <span style="font-size: 12px; color: #8696a0;">Delivered client reminders:</span>
                    <button type="button" class="clear-btn" onclick="clearHistory()">Clear All History 🗑️</button>
                </div>` : ''}
            ${sentReminders.length === 0 ? '<p style="text-align:center; padding: 14px 0;">No sent reminder history yet.</p>' : 
                sentReminders.map(r => `
                    <div class="rem-item sent-item">
                        <div style="flex: 1;">
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                                <strong>+${r.phone}</strong>
                                <span class="status-badge ${r.status === 'sent' ? 'sent' : 'failed'}">
                                    ${r.status === 'sent' ? '✅ Delivered' : '❌ Failed'}
                                </span>
                            </div>
                            <em style="color:#8696a0; font-size: 12px;">📅 Sent: ${formatSLTime(r.sentAt || r.time)}</em><br>
                            <span style="color:#e9edef; margin-top: 4px; display: inline-block;">"${r.message}"</span>
                            ${r.error ? `<br><small style="color:#ea4335;">⚠️ Error: ${r.error}</small>` : ''}
                        </div>
                        <button class="del-btn" style="margin-left: 12px;" onclick="deleteSingleHistory('${r.id}')" title="Delete from history">✕</button>
                    </div>
                `).join('')}
        </div>

        <!-- Quick Send Section -->
        <h2>⚡ Quick Send Message</h2>
        <div class="quick-send-form">
            <form id="quickSendForm">
                <label>Phone Number:</label>
                <input type="text" id="qsPhone" placeholder="e.g. 0771234567" required>
                <label style="margin-top: 10px;">Message:</label>
                <textarea id="qsMsg" rows="3" placeholder="Type your message here..." required></textarea>
                <button type="submit" class="send-now-btn">Send Now ⚡</button>
            </form>
        </div>

        <!-- Contact Book Section -->
        <h2>📇 Contact Book</h2>
        <div id="contactBookArea">
            <p style="text-align:center; color: #8696a0; font-size: 13px;">Loading contacts...</p>
        </div>
    </div>

    <!-- Toast Notification Element -->
    <div class="toast" id="toastNotif"></div>

    <script>
        document.getElementById('remForm').onsubmit = async (e) => {
            e.preventDefault();
            const phone = document.getElementById('remPhone').value;
            const rawTime = document.getElementById('remTime').value;
            const message = document.getElementById('remMsg').value;

            let time = rawTime;
            try {
                const dateObj = new Date(rawTime);
                if (!isNaN(dateObj.getTime())) {
                    time = dateObj.toISOString();
                }
            } catch (err) {}

            const res = await fetch('/api/reminders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone, time, message })
            });
            const data = await res.json();
            if (data.success) {
                alert('✅ Payment reminder scheduled successfully!');
                location.reload();
            } else {
                alert('❌ Error: ' + (data.error || 'Failed to schedule'));
            }
        };

        async function cancelRem(id) {
            if (!confirm('Cancel this scheduled reminder?')) return;
            await fetch('/api/reminders/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id })
            });
            location.reload();
        }

        // Live Real-Time Countdown Timer
        function updateCountdowns() {
            const badges = document.querySelectorAll('.countdown-badge');
            const now = Date.now();

            badges.forEach(badge => {
                const target = new Date(badge.getAttribute('data-target')).getTime();
                const diff = target - now;

                if (diff <= 0) {
                    badge.textContent = '🚀 Sending now...';
                    badge.className = 'countdown-badge expired';
                } else {
                    const totalSeconds = Math.floor(diff / 1000);
                    const days = Math.floor(totalSeconds / 86400);
                    const hours = Math.floor((totalSeconds % 86400) / 3600);
                    const minutes = Math.floor((totalSeconds % 3600) / 60);
                    const seconds = totalSeconds % 60;

                    let text = '⏳ in ';
                    if (days > 0) text += days + 'd ';
                    if (hours > 0 || days > 0) text += hours + 'h ';
                    text += String(minutes).padStart(2, '0') + 'm ' + String(seconds).padStart(2, '0') + 's';

                    badge.textContent = text;
                    badge.className = 'countdown-badge';
                }
            });
        }

        setInterval(updateCountdowns, 1000);
        updateCountdowns();

        // Setup Date-Time Calendar Input Min and Default values
        function initTimeInput() {
            var timeInput = document.getElementById('remTime');
            var now = new Date();
            function pad(n) { return n < 10 ? '0' + n : n; }
            function toLocal(d) {
                return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
            }

            timeInput.min = toLocal(now);
            var defaultTime = new Date(now.getTime() + 60 * 60 * 1000);
            timeInput.value = toLocal(defaultTime);
        }

        function setPreset(mins) {
            var target = new Date(Date.now() + mins * 60 * 1000);
            function pad(n) { return n < 10 ? '0' + n : n; }
            document.getElementById('remTime').value = target.getFullYear() + '-' + pad(target.getMonth() + 1) + '-' + pad(target.getDate()) + 'T' + pad(target.getHours()) + ':' + pad(target.getMinutes());
        }

        function setTomorrow(hours, mins) {
            var target = new Date();
            target.setDate(target.getDate() + 1);
            target.setHours(hours, mins, 0, 0);
            function pad(n) { return n < 10 ? '0' + n : n; }
            document.getElementById('remTime').value = target.getFullYear() + '-' + pad(target.getMonth() + 1) + '-' + pad(target.getDate()) + 'T' + pad(target.getHours()) + ':' + pad(target.getMinutes());
        }

        function setDaysAhead(days, hours, mins) {
            var target = new Date();
            target.setDate(target.getDate() + days);
            target.setHours(hours || 10, mins || 0, 0, 0);
            function pad(n) { return n < 10 ? '0' + n : n; }
            document.getElementById('remTime').value = target.getFullYear() + '-' + pad(target.getMonth() + 1) + '-' + pad(target.getDate()) + 'T' + pad(target.getHours()) + ':' + pad(target.getMinutes());
        }

        // 69 Studio Quick Message Templates
        const templates = ${JSON.stringify(reminderTemplates)};

        function applyTemplate(key) {
            if (!key || !templates[key]) return;
            document.getElementById('remMsg').value = templates[key];
        }

        // Tabs: Pending vs Sent History
        function switchTab(tab) {
            const pendingTab = document.getElementById('pendingTabContent');
            const historyTab = document.getElementById('historyTabContent');
            const tabPendingBtn = document.getElementById('tabPendingBtn');
            const tabHistoryBtn = document.getElementById('tabHistoryBtn');

            if (tab === 'pending') {
                pendingTab.style.display = 'block';
                historyTab.style.display = 'none';
                tabPendingBtn.classList.add('active');
                tabHistoryBtn.classList.remove('active');
            } else {
                pendingTab.style.display = 'none';
                historyTab.style.display = 'block';
                tabPendingBtn.classList.remove('active');
                tabHistoryBtn.classList.add('active');
            }
        }

        // Clear All Sent History
        async function clearHistory() {
            if (!confirm('Are you sure you want to clear all delivered reminders history?')) return;
            const res = await fetch('/api/reminders/clear-history', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                location.reload();
            } else {
                alert('Failed to clear history');
            }
        }

        // Delete Single History Record
        async function deleteSingleHistory(id) {
            if (!confirm('Remove this reminder from history?')) return;
            const res = await fetch('/api/reminders/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id })
            });
            const data = await res.json();
            if (data.success) {
                location.reload();
            }
        }

        initTimeInput();

        // --- Quick Send Form ---
        document.getElementById('quickSendForm').onsubmit = async (e) => {
            e.preventDefault();
            const phone = document.getElementById('qsPhone').value;
            const message = document.getElementById('qsMsg').value;

            const res = await fetch('/api/send-now', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone, message })
            });
            const data = await res.json();
            if (data.success) {
                showToast('✅ Message sent to +' + (data.phone || phone) + '!');
                document.getElementById('qsPhone').value = '';
                document.getElementById('qsMsg').value = '';
            } else {
                alert('❌ Error: ' + (data.error || 'Failed to send'));
            }
        };

        // --- Toast Notification ---
        function showToast(message, duration) {
            const toast = document.getElementById('toastNotif');
            toast.textContent = message;
            toast.classList.add('show');
            setTimeout(() => { toast.classList.remove('show'); }, duration || 4000);
        }

        // --- Analytics Chart ---
        async function loadAnalytics() {
            try {
                const res = await fetch('/api/analytics');
                const data = await res.json();

                // Update stat cards
                const sp = document.getElementById('statPending');
                const ss = document.getElementById('statSent');
                const sf = document.getElementById('statFailed');
                const sc = document.getElementById('statContacts');
                if (sp) sp.textContent = data.totalPending;
                if (ss) ss.textContent = data.totalSent;
                if (sf) sf.textContent = data.totalFailed;
                if (sc) sc.textContent = data.uniqueContacts;

                // Build bar chart
                const chart = document.getElementById('barChart');
                if (chart && data.dailyCounts) {
                    const maxCount = Math.max(...data.dailyCounts.map(d => d.count), 1);
                    chart.innerHTML = data.dailyCounts.map(d => {
                        const height = Math.max((d.count / maxCount) * 60, 4);
                        return '<div class="chart-bar-wrapper">' +
                            '<span class="chart-bar-count">' + d.count + '</span>' +
                            '<div class="chart-bar" style="height:' + height + 'px"></div>' +
                            '<span class="chart-bar-label">' + d.day + '</span>' +
                            '</div>';
                    }).join('');
                }
            } catch (e) {
                console.warn('Analytics load failed:', e);
            }
        }
        loadAnalytics();

        // --- Contact Book ---
        async function loadContacts() {
            try {
                const res = await fetch('/api/contacts');
                const contacts = await res.json();
                const area = document.getElementById('contactBookArea');

                if (!contacts || contacts.length === 0) {
                    area.innerHTML = '<p style="text-align:center; padding: 14px 0; color: #8696a0;">No contacts in history yet.</p>';
                    return;
                }

                area.innerHTML = contacts.map(c => {
                    return '<div class="contact-item">' +
                        '<div style="flex:1;">' +
                            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">' +
                                '<strong>+' + c.phone + '</strong>' +
                                (c.isBlocked ? '<span class="status-badge failed">🔒 Blocked</span>' : '') +
                            '</div>' +
                            '<span style="font-size:12px;color:#8696a0;">' +
                                '✅ ' + c.sentCount + ' sent | ⏳ ' + c.pendingCount + ' pending | 📝 ' + c.notes + ' notes' +
                            '</span>' +
                            (c.lastContact ? '<br><span style="font-size:11px;color:#666;">Last: ' + new Date(c.lastContact).toLocaleDateString() + '</span>' : '') +
                        '</div>' +
                        '<div class="contact-actions">' +
                            '<button class="preset-btn" onclick="prefillReminder(\'' + c.phone + '\')" title="New Reminder">📅</button>' +
                            '<button class="preset-btn" onclick="quickSendTo(\'' + c.phone + '\')" title="Quick Send">⚡</button>' +
                        '</div>' +
                    '</div>';
                }).join('');
            } catch (e) {
                console.warn('Contact book load failed:', e);
            }
        }
        loadContacts();

        function prefillReminder(phone) {
            document.getElementById('remPhone').value = phone;
            document.getElementById('remPhone').scrollIntoView({ behavior: 'smooth' });
        }

        function quickSendTo(phone) {
            document.getElementById('qsPhone').value = phone;
            document.getElementById('qsMsg').focus();
            document.getElementById('qsPhone').scrollIntoView({ behavior: 'smooth' });
        }

        // --- Browser Notifications ---
        let notifPermission = 'default';
        async function initNotifications() {
            if ('Notification' in window) {
                notifPermission = Notification.permission;
                if (notifPermission === 'default') {
                    notifPermission = await Notification.requestPermission();
                }
            }
        }
        initNotifications();

        let lastNotifCount = 0;
        async function checkNotifications() {
            try {
                const res = await fetch('/api/notifications');
                const data = await res.json();
                const countEl = document.getElementById('notifCount');

                if (data.count > 0) {
                    countEl.style.display = 'inline';
                    countEl.textContent = data.count;
                    document.title = '(' + data.count + ') ' + '${BOT_NAME} - Dashboard';

                    // Show browser notification for new ones
                    if (data.count > lastNotifCount && notifPermission === 'granted') {
                        const latest = data.notifications[data.notifications.length - 1];
                        new Notification('🤖 ${BOT_NAME}', {
                            body: latest.message,
                            icon: '/favicon.ico',
                            tag: latest.id
                        });
                        showToast(latest.message);
                    }
                    lastNotifCount = data.count;
                } else {
                    countEl.style.display = 'none';
                    document.title = '${BOT_NAME} - Dashboard';
                    lastNotifCount = 0;
                }

                // Mark as read when bell is clicked
                if (data.count > 0) {
                    await fetch('/api/notifications/read', { method: 'POST' });
                }
            } catch (e) {
                console.warn('Notification check failed:', e);
            }
        }

        // Auto-check notifications every 30 seconds
        setInterval(checkNotifications, 30000);
        checkNotifications();

        // Auto-refresh analytics every 60 seconds
        setInterval(() => {
            loadAnalytics();
            loadContacts();
        }, 60000);
    </script>
</body>
</html>`;
    res.end(html);
});

server.listen(PORT, () => {
    console.log(`🌐 HTTP Cloud Server listening on port ${PORT}`);
});

// Self-ping to prevent free cloud platforms (e.g. Render) from sleeping
const cloudUrl = process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL;
if (cloudUrl) {
    console.log(`⚡ Keep-Alive Anti-Sleep enabled for: ${cloudUrl}`);
    setInterval(async () => {
        try {
            const healthUrl = `${cloudUrl.replace(/\/$/, '')}/health`;
            await fetch(healthUrl);
            console.log(`💓 Pinged ${healthUrl} to stay awake.`);
        } catch (e) {
            console.warn(`⚠️ Keep-alive ping failed:`, e.message);
        }
    }, 10 * 60 * 1000);
}

/**
 * Start the WhatsApp Bot
 */
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion();

    console.log(`\n========================================`);
    console.log(`🤖 ${BOT_NAME} — ${OWNER_NAME}'s WhatsApp Auto-Reply & Reminders Bot`);
    console.log(`🌐 Website: ${MY_WEBSITE}`);
    console.log(`========================================\n`);

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: false
    });

    currentSock = sock; // Expose socket to reminder worker

    // Connection Updates
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            lastQR = qr;
            currentStatus = 'scan_qr';
            console.log('\n📲 SCAN THE QR CODE TO LINK WHATSAPP:');
            console.log('(WhatsApp > Settings > Linked Devices > Link a Device)\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            lastQR = null;
            currentStatus = 'reconnecting';
            const statusCode = (new Boom(lastDisconnect?.error))?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(`❌ WhatsApp Disconnected (Code: ${statusCode})`);

            if (shouldReconnect) {
                console.log('🔄 Reconnecting in 3 seconds...');
                setTimeout(startBot, 3000);
            } else {
                console.log('🚪 Session logged out. Clearing old session...');
                if (fs.existsSync(authFolder)) {
                    fs.rmSync(authFolder, { recursive: true, force: true });
                }
                setTimeout(startBot, 3000);
            }
        } else if (connection === 'open') {
            lastQR = null;
            currentStatus = 'connected';
            const botNumber = sock.user?.id?.split(':')[0] || 'Unknown';
            console.log('\n🎉 ========================================');
            console.log(`✅ ${BOT_NAME} CONNECTED & LIVE 24/7!`);
            console.log(`📱 Active on Number: +${botNumber}`);
            console.log(`👤 Owner: ${OWNER_NAME}`);
            console.log(`⏰ Scheduled Reminders: ACTIVE`);
            console.log('========================================\n');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    const botStartTime = Date.now();

    // Incoming Messages
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg || !msg.message) continue;

            const from = msg.key.remoteJid || '';

            // Strictly ignore groups & newsletters
            const isGroupOrChannel = from.endsWith('@g.us') || 
                                     from.endsWith('@newsletter') || 
                                     from.includes('@broadcast') || 
                                     !!msg.key.participant;
            if (isGroupOrChannel) continue;

            // Only direct 1-on-1 chats
            if (!from.endsWith('@s.whatsapp.net') && !from.endsWith('@lid')) continue;

            const senderNumber = from.replace(/@.*$/, '');
            const senderName = msg.pushName || '';

            // Extract message body
            const msgContent = msg.message.ephemeralMessage?.message ||
                               msg.message.viewOnceMessage?.message ||
                               msg.message.viewOnceMessageV2?.message ||
                               msg.message;

            const bodyText = (msgContent.conversation ||
                              msgContent.extendedTextMessage?.text ||
                              msgContent.imageMessage?.caption ||
                              '').trim();

            const isOwner = msg.key.fromMe || (OWNER_NUMBER && senderNumber.includes(OWNER_NUMBER));

            // --- OWNER COMMANDS (Reminders & Scheduling) ---
            if (isOwner && bodyText.startsWith('.')) {
                const lowerCmd = bodyText.toLowerCase();

                // 1. .remind <phone> | <time> | <message>
                if (lowerCmd.startsWith('.remind ')) {
                    const parts = bodyText.substring(8).split('|');
                    if (parts.length < 3) {
                        await sock.sendMessage(from, { 
                            text: `❌ *Format Error!*\nUse: \`.remind <phone> | <time> | <message>\`\n\n*Examples:*\n• \`.remind 0771234567 | 2h | Payment reminder for 69 Studio\`\n• \`.remind 0771234567 | tomorrow 10:00 | Please settle the invoice\`\n• \`.remind 0771234567 | 2026-09-15 14:00 | Payment reminder\``
                        }, { quoted: msg });
                        continue;
                    }

                    const rawPhone = parts[0].trim();
                    const rawTime = parts[1].trim();
                    const rawMsg = parts.slice(2).join('|').trim();

                    const phone = sanitizePhoneNumber(rawPhone);
                    const scheduledDate = parseScheduledTime(rawTime);

                    if (!phone || phone.length < 9) {
                        await sock.sendMessage(from, { text: `❌ Invalid phone number: "${rawPhone}"` }, { quoted: msg });
                        continue;
                    }

                    if (!scheduledDate || scheduledDate.getTime() <= Date.now()) {
                        await sock.sendMessage(from, { text: `❌ Invalid time: "${rawTime}". Must be a future time (e.g. 2h, 30m, tomorrow 10:00).` }, { quoted: msg });
                        continue;
                    }

                    const newRem = {
                        id: 'rem_' + Date.now(),
                        phone,
                        time: scheduledDate.toISOString(),
                        message: rawMsg,
                        status: 'pending',
                        createdAt: new Date().toISOString()
                    };

                    const reminders = loadReminders();
                    reminders.push(newRem);
                    saveReminders(reminders);

                    const confirmText = `✅ *Payment Reminder Scheduled!*\n\n` +
                                        `📱 *Client:* +${phone}\n` +
                                        `📅 *Date & Time:* ${formatSLTime(scheduledDate)}\n` +
                                        `💬 *Message:* "${rawMsg}"\n` +
                                        `🆔 *ID:* \`${newRem.id}\`\n\n` +
                                        `_Olivia will automatically send this message at the scheduled time!_ ⏰`;

                    await sock.sendMessage(from, { text: confirmText }, { quoted: msg });
                    console.log(`📅 Reminder scheduled for +${phone} at ${formatSLTime(scheduledDate)}`);
                    continue;
                }

                // 2. .reminders (List all pending reminders)
                if (lowerCmd === '.reminders' || lowerCmd === '.remind list') {
                    const reminders = loadReminders();
                    const pending = reminders.filter(r => r.status === 'pending');

                    if (pending.length === 0) {
                        await sock.sendMessage(from, { text: `📋 *No pending payment reminders scheduled.*` }, { quoted: msg });
                    } else {
                        let listText = `📋 *Active Scheduled Reminders (${pending.length}):*\n\n`;
                        pending.forEach((r, idx) => {
                            listText += `*${idx + 1}.* +${r.phone}\n` +
                                        `⏱️ ${formatSLTime(r.time)}\n` +
                                        `💬 "${r.message}"\n` +
                                        `🆔 \`${r.id}\`\n\n`;
                        });
                        listText += `_To cancel, send: \`.delremind <ID>\`_`;
                        await sock.sendMessage(from, { text: listText }, { quoted: msg });
                    }
                    continue;
                }

                // 3. .delremind <id> (Cancel a reminder)
                if (lowerCmd.startsWith('.delremind ')) {
                    const remId = bodyText.substring(11).trim();
                    let reminders = loadReminders();
                    const initialLen = reminders.length;
                    reminders = reminders.filter(r => r.id !== remId);

                    if (reminders.length < initialLen) {
                        saveReminders(reminders);
                        await sock.sendMessage(from, { text: `✅ Reminder \`${remId}\` has been cancelled.` }, { quoted: msg });
                    } else {
                        await sock.sendMessage(from, { text: `❌ Reminder ID \`${remId}\` not found.` }, { quoted: msg });
                    }
                    continue;
                }

                // 4. .bank <phone> (Send 69 Studio bank transfer details)
                if (lowerCmd.startsWith('.bank ') || lowerCmd === '.bank') {
                    let targetPhone = bodyText.substring(5).trim();
                    let targetJid = from;

                    if (targetPhone) {
                        const sanitized = sanitizePhoneNumber(targetPhone);
                        if (sanitized && sanitized.length >= 9) {
                            targetJid = `${sanitized}@s.whatsapp.net`;
                        }
                    }

                    const bankMsg = `🏦 *69 Studio - Payment Transfer Details*\n\n` +
                                    `💳 *Bank:* SAMPATH BANK PLC\n` +
                                    `👤 *Account Name:* K S SALIYA\n` +
                                    `🔢 *Account No:* 1122 5249 1630\n` +
                                    `📍 *Branch:* RAJAGIRIYA BRANCH\n\n` +
                                    `_Please share a screenshot of the deposit slip once transferred. Thank you!_ 🙏`;

                    await sock.sendMessage(targetJid, { text: bankMsg });
                    if (targetJid !== from) {
                        await sock.sendMessage(from, { text: `✅ Bank transfer details sent to *+${targetJid.replace(/@.*$/, '')}*!` }, { quoted: msg });
                    } else {
                        await sock.sendMessage(from, { text: `✅ Bank transfer details generated!` }, { quoted: msg });
                    }
                    continue;
                }

                // 5. .help (Show all available commands)
                if (lowerCmd === '.help' || lowerCmd === '.commands' || lowerCmd === '.menu') {
                    const helpText = `🤖 *${BOT_NAME} — Owner Commands*\n\n` +
                        `📋 *Reminder Commands:*\n` +
                        `• \`.remind <phone> | <time> | <message>\` — Schedule a reminder\n` +
                        `• \`.reminders\` — View all pending reminders\n` +
                        `• \`.delremind <id>\` — Cancel a reminder\n\n` +
                        `💬 *Messaging Commands:*\n` +
                        `• \`.send <phone> | <message>\` — Send instant message\n` +
                        `• \`.broadcast <message>\` — Send to all contacts\n` +
                        `• \`.bank <phone>\` — Send bank transfer details\n\n` +
                        `📝 *Notes & Contacts:*\n` +
                        `• \`.note <phone> | <note>\` — Add client note\n` +
                        `• \`.notes <phone>\` — View client notes\n\n` +
                        `🔒 *Auto-Reply Control:*\n` +
                        `• \`.block <phone>\` — Block auto-reply for a number\n` +
                        `• \`.unblock <phone>\` — Unblock auto-reply\n` +
                        `• \`.blocklist\` — View all blocked numbers\n\n` +
                        `📊 *Status:*\n` +
                        `• \`.status\` — Bot status summary\n\n` +
                        `_Type any command to get started!_ ✨`;

                    await sock.sendMessage(from, { text: helpText }, { quoted: msg });
                    continue;
                }

                // 6. .send <phone> | <message> (Quick direct message)
                if (lowerCmd.startsWith('.send ')) {
                    const parts = bodyText.substring(6).split('|');
                    if (parts.length < 2) {
                        await sock.sendMessage(from, {
                            text: `❌ *Format Error!*\nUse: \`.send <phone> | <message>\`\n\n*Example:*\n\`.send 0771234567 | Your payment has been received!\``
                        }, { quoted: msg });
                        continue;
                    }

                    const targetPhone = sanitizePhoneNumber(parts[0].trim());
                    const sendMsg = parts.slice(1).join('|').trim();

                    if (!targetPhone || targetPhone.length < 9) {
                        await sock.sendMessage(from, { text: `❌ Invalid phone number.` }, { quoted: msg });
                        continue;
                    }

                    const targetJid = `${targetPhone}@s.whatsapp.net`;
                    await sock.sendMessage(targetJid, { text: sendMsg });
                    await sock.sendMessage(from, {
                        text: `✅ Message sent to *+${targetPhone}*!\n💬 "${sendMsg.substring(0, 100)}${sendMsg.length > 100 ? '...' : ''}"`
                    }, { quoted: msg });
                    console.log(`📤 Direct message sent to +${targetPhone}`);
                    continue;
                }

                // 7. .broadcast <message> (Send to all known contacts)
                if (lowerCmd.startsWith('.broadcast ')) {
                    const broadcastMsg = bodyText.substring(11).trim();
                    if (!broadcastMsg) {
                        await sock.sendMessage(from, { text: `❌ Please provide a message.\nUse: \`.broadcast <message>\`` }, { quoted: msg });
                        continue;
                    }

                    const reminders = loadReminders();
                    const uniquePhones = [...new Set(reminders.map(r => r.phone))];

                    if (uniquePhones.length === 0) {
                        await sock.sendMessage(from, { text: `❌ No contacts found in reminder history.` }, { quoted: msg });
                        continue;
                    }

                    await sock.sendMessage(from, {
                        text: `📡 Broadcasting to *${uniquePhones.length}* contacts...`
                    }, { quoted: msg });

                    let successCount = 0;
                    let failCount = 0;

                    for (const phone of uniquePhones) {
                        try {
                            await sock.sendMessage(`${phone}@s.whatsapp.net`, { text: broadcastMsg });
                            successCount++;
                            await sleep(1000); // Rate limiting
                        } catch (e) {
                            failCount++;
                            console.error(`Failed to broadcast to +${phone}:`, e.message);
                        }
                    }

                    await sock.sendMessage(from, {
                        text: `✅ *Broadcast Complete!*\n\n📤 Sent: *${successCount}*\n❌ Failed: *${failCount}*\n📋 Total: *${uniquePhones.length}*`
                    });
                    console.log(`📡 Broadcast sent to ${successCount}/${uniquePhones.length} contacts`);
                    continue;
                }

                // 8. .status (Bot status summary)
                if (lowerCmd === '.status') {
                    const reminders = loadReminders();
                    const pending = reminders.filter(r => r.status === 'pending').length;
                    const sent = reminders.filter(r => r.status === 'sent').length;
                    const failed = reminders.filter(r => r.status === 'failed').length;
                    const uniqueContacts = [...new Set(reminders.map(r => r.phone))].length;
                    const blocked = loadBlocked();
                    const uptimeMin = Math.floor(process.uptime() / 60);
                    const uptimeHrs = Math.floor(uptimeMin / 60);
                    const uptimeRemMin = uptimeMin % 60;

                    const statusText = `📊 *${BOT_NAME} Status Report*\n\n` +
                        `🟢 *Status:* ${currentStatus === 'connected' ? 'Online & Active' : currentStatus}\n` +
                        `⏱️ *Uptime:* ${uptimeHrs}h ${uptimeRemMin}m\n` +
                        `🤖 *AI Mode:* ${USE_AI ? 'Enabled (Gemini)' : 'Standard Auto-Reply'}\n\n` +
                        `📋 *Reminders:*\n` +
                        `  ⏳ Pending: *${pending}*\n` +
                        `  ✅ Sent: *${sent}*\n` +
                        `  ❌ Failed: *${failed}*\n\n` +
                        `👥 *Contacts Served:* ${uniqueContacts}\n` +
                        `🔒 *Blocked Numbers:* ${blocked.length}\n` +
                        `⏰ *Cooldown:* ${COOLDOWN_MINUTES} mins\n\n` +
                        `🌐 *Dashboard:* ${process.env.RENDER_EXTERNAL_URL || 'http://localhost:' + PORT}`;

                    await sock.sendMessage(from, { text: statusText }, { quoted: msg });
                    continue;
                }

                // 9. .block <phone> (Block auto-reply for a number)
                if (lowerCmd.startsWith('.block ')) {
                    const rawPhone = bodyText.substring(7).trim();
                    const phone = sanitizePhoneNumber(rawPhone);

                    if (!phone || phone.length < 9) {
                        await sock.sendMessage(from, { text: `❌ Invalid phone number: "${rawPhone}"` }, { quoted: msg });
                        continue;
                    }

                    const blocked = loadBlocked();
                    if (blocked.includes(phone)) {
                        await sock.sendMessage(from, { text: `⚠️ *+${phone}* is already blocked.` }, { quoted: msg });
                    } else {
                        blocked.push(phone);
                        saveBlocked(blocked);
                        await sock.sendMessage(from, { text: `🔒 *+${phone}* has been blocked from auto-reply.` }, { quoted: msg });
                        console.log(`🔒 Blocked auto-reply for +${phone}`);
                    }
                    continue;
                }

                // 10. .unblock <phone>
                if (lowerCmd.startsWith('.unblock ')) {
                    const rawPhone = bodyText.substring(9).trim();
                    const phone = sanitizePhoneNumber(rawPhone);

                    if (!phone || phone.length < 9) {
                        await sock.sendMessage(from, { text: `❌ Invalid phone number: "${rawPhone}"` }, { quoted: msg });
                        continue;
                    }

                    let blocked = loadBlocked();
                    if (blocked.includes(phone)) {
                        blocked = blocked.filter(b => b !== phone);
                        saveBlocked(blocked);
                        await sock.sendMessage(from, { text: `🔓 *+${phone}* has been unblocked. Auto-reply is now active.` }, { quoted: msg });
                        console.log(`🔓 Unblocked auto-reply for +${phone}`);
                    } else {
                        await sock.sendMessage(from, { text: `⚠️ *+${phone}* is not in the blocked list.` }, { quoted: msg });
                    }
                    continue;
                }

                // 11. .blocklist (View all blocked numbers)
                if (lowerCmd === '.blocklist' || lowerCmd === '.blocked') {
                    const blocked = loadBlocked();
                    if (blocked.length === 0) {
                        await sock.sendMessage(from, { text: `🔓 *No blocked numbers.* All contacts receive auto-replies.` }, { quoted: msg });
                    } else {
                        let listText = `🔒 *Blocked Numbers (${blocked.length}):*\n\n`;
                        blocked.forEach((phone, idx) => {
                            listText += `${idx + 1}. +${phone}\n`;
                        });
                        listText += `\n_To unblock: \`.unblock <phone>\`_`;
                        await sock.sendMessage(from, { text: listText }, { quoted: msg });
                    }
                    continue;
                }

                // 12. .note <phone> | <note> (Add client note)
                if (lowerCmd.startsWith('.note ')) {
                    const parts = bodyText.substring(6).split('|');
                    if (parts.length < 2) {
                        await sock.sendMessage(from, {
                            text: `❌ *Format Error!*\nUse: \`.note <phone> | <note text>\`\n\n*Example:*\n\`.note 0771234567 | Logo project - Rs.15000 pending\``
                        }, { quoted: msg });
                        continue;
                    }

                    const phone = sanitizePhoneNumber(parts[0].trim());
                    const noteText = parts.slice(1).join('|').trim();

                    if (!phone || phone.length < 9) {
                        await sock.sendMessage(from, { text: `❌ Invalid phone number.` }, { quoted: msg });
                        continue;
                    }

                    const notes = loadNotes();
                    if (!notes[phone]) notes[phone] = [];
                    notes[phone].push({
                        text: noteText,
                        createdAt: new Date().toISOString()
                    });
                    saveNotes(notes);

                    await sock.sendMessage(from, {
                        text: `📝 *Note added for +${phone}!*\n💬 "${noteText}"\n\n_Total notes for this contact: ${notes[phone].length}_`
                    }, { quoted: msg });
                    continue;
                }

                // 13. .notes <phone> (View client notes)
                if (lowerCmd.startsWith('.notes ') || lowerCmd === '.notes') {
                    const rawPhone = bodyText.substring(7).trim();

                    if (!rawPhone) {
                        // Show all contacts with notes
                        const notes = loadNotes();
                        const phones = Object.keys(notes);
                        if (phones.length === 0) {
                            await sock.sendMessage(from, { text: `📝 *No client notes saved yet.*` }, { quoted: msg });
                        } else {
                            let listText = `📝 *Contacts with Notes (${phones.length}):*\n\n`;
                            phones.forEach((phone, idx) => {
                                listText += `${idx + 1}. +${phone} — ${notes[phone].length} note(s)\n`;
                            });
                            listText += `\n_View notes: \`.notes <phone>\`_`;
                            await sock.sendMessage(from, { text: listText }, { quoted: msg });
                        }
                        continue;
                    }

                    const phone = sanitizePhoneNumber(rawPhone);
                    const notes = loadNotes();

                    if (!notes[phone] || notes[phone].length === 0) {
                        await sock.sendMessage(from, { text: `📝 *No notes found for +${phone}.*` }, { quoted: msg });
                    } else {
                        let notesList = `📝 *Notes for +${phone}* (${notes[phone].length}):\n\n`;
                        notes[phone].forEach((n, idx) => {
                            notesList += `*${idx + 1}.* ${n.text}\n   _${formatSLTime(n.createdAt)}_\n\n`;
                        });
                        await sock.sendMessage(from, { text: notesList }, { quoted: msg });
                    }
                    continue;
                }
            }

            // Ignore messages sent by Owner for auto-reply
            if (isOwner) continue;

            // Check if sender is blocked from auto-reply
            if (isBlocked(senderNumber)) {
                console.log(`🔒 Skipped auto-reply for ${senderName || senderNumber} (BLOCKED).`);
                continue;
            }

            // Only reply to new messages
            const msgTimestampSec = typeof msg.messageTimestamp === 'number' 
                ? msg.messageTimestamp 
                : (msg.messageTimestamp?.low || Number(msg.messageTimestamp) || 0);
            const msgTimeMs = msgTimestampSec * 1000;

            if (msgTimeMs && (msgTimeMs < botStartTime - 5000 || (Date.now() - msgTimeMs) > 120000)) {
                continue;
            }

            console.log(`📩 New message from ${senderName || senderNumber}: ${bodyText || '[Media/Other]'}`);

            // Anti-spam cooldown
            const now = Date.now();
            const lastTime = lastReplyMap.get(from) || 0;
            const cooldownMs = COOLDOWN_MINUTES * 60 * 1000;

            if (now - lastTime < cooldownMs) {
                console.log(`⏳ Skipped auto-reply for ${senderName || senderNumber} (Already notified within last ${COOLDOWN_MINUTES} mins).`);
                continue;
            }

            try {
                // Blue tick
                await sleep(500);
                await sock.readMessages([msg.key]);

                // Typing
                await sock.sendPresenceUpdate('composing', from);
                await sleep(1500);

                // Prepare reply
                let reply = '';
                if (USE_AI && bodyText) {
                    reply = await getSmartAIReply(bodyText, senderName);
                } else {
                    reply = getBusyMessage(senderName);
                }

                // Send reply
                await sock.sendMessage(from, { text: reply }, { quoted: msg });
                lastReplyMap.set(from, now);

                console.log(`✅ Auto-reply sent to ${senderName || senderNumber}!\n`);
                await sock.sendPresenceUpdate('paused', from);
            } catch (err) {
                console.error(`❌ Failed to send reply to ${from}:`, err.message);
                await sock.sendPresenceUpdate('paused', from);
            }
        }
    });
}

// Graceful Termination
process.on('SIGINT', () => {
    console.log('\n🛑 Stopping bot...');
    server.close();
    process.exit(0);
});

startBot().catch(err => {
    console.error('Fatal initialization error:', err);
});
