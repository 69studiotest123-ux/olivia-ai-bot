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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authFolder = path.join(__dirname, 'auth_info_baileys');
const remindersFile = path.join(__dirname, 'reminders.json');

// --- Settings from .env ---
const BOT_NAME = process.env.BOT_NAME || 'Olivia';
const OWNER_NAME = process.env.OWNER_NAME || 'Subhash';
const MY_WEBSITE = process.env.MY_WEBSITE || 'https://69studiobysubash.online/';
const OWNER_NUMBER = (process.env.OWNER_NUMBER || '').replace(/[^0-9]/g, '');
const COOLDOWN_MINUTES = parseInt(process.env.COOLDOWN_MINUTES || '10', 10);
const USE_AI = process.env.USE_AI === 'true' && !!process.env.GEMINI_API_KEY;
const PORT = process.env.PORT || 3000;

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
            model: 'gemini-2.0-flash',
            systemInstruction: systemPrompt
        });

        const result = await model.sendMessage(userText);
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

                    // Notify Subhash (Owner)
                    const ownerJid = OWNER_NUMBER 
                        ? `${OWNER_NUMBER}@s.whatsapp.net` 
                        : (currentSock.user?.id ? currentSock.user.id.split(':')[0] + '@s.whatsapp.net' : null);

                    if (ownerJid) {
                        const confirmMsg = `🔔 *[Auto-Reminder Sent]*\n\n` +
                                           `✅ Payment reminder successfully delivered to: *+${rem.phone}*\n` +
                                           `💬 *Message:* "${rem.message}"\n` +
                                           `⏱️ *Time:* ${new Date().toLocaleTimeString()}`;
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

        console.log(`📅 Web UI Scheduled Reminder for +${phone} at ${scheduledTime.toLocaleString()}`);

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
        input, textarea { width: 100%; box-sizing: border-box; background: #202c33; border: 1px solid #2a3942; border-radius: 8px; padding: 10px; color: #e9edef; font-size: 14px; margin-top: 4px; }
        input:focus, textarea:focus { outline: none; border-color: #00a884; }
        button { background: #00a884; color: #111; font-weight: 600; border: none; padding: 12px 20px; border-radius: 8px; cursor: pointer; width: 100%; margin-top: 16px; font-size: 15px; }
        button:hover { background: #06cf9c; }
        
        .rem-item { background: #202c33; border-radius: 8px; padding: 10px 14px; margin-top: 8px; text-align: left; font-size: 13px; border-left: 3px solid #00a884; display: flex; justify-content: space-between; align-items: center; }
        .del-btn { background: #ea4335; color: #fff; border: none; border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: 12px; width: auto; margin-top: 0; }
    </style>
</head>
<body>
    <div class="card">
        <div style="text-align: center;">
            <span class="badge">${currentStatus === 'connected' ? '🟢 ONLINE 24/7' : '🟡 ' + currentStatus.toUpperCase()}</span>
            <h1>🤖 ${BOT_NAME}</h1>
            <p>Personal Assistant for <strong>${OWNER_NAME}</strong> | Uptime: <strong>${uptimeMin} mins</strong></p>
            <p>🌐 Website: <a href="${MY_WEBSITE}" target="_blank">${MY_WEBSITE}</a></p>
            ${lastQR ? '<div class="qr-box"><img src="/qr" alt="QR Code" width="200"><p style="color:#111;margin:6px 0 0 0;font-size:12px;">Scan with WhatsApp</p></div>' : ''}
        </div>

        <h2>📅 Schedule Payment Auto-Reminder</h2>
        <form id="remForm">
            <label>Client Phone Number:</label>
            <input type="text" id="remPhone" placeholder="e.g. 0771234567 or 94771234567" required>

            <label>Schedule Time (e.g. "2h", "30m", "tomorrow 10:00", or pick date):</label>
            <input type="text" id="remTime" placeholder="e.g. 2h, tomorrow 10:00, or 2026-09-15 10:30" required>

            <label>Reminder Message:</label>
            <textarea id="remMsg" rows="3" placeholder="Hello! Friendly payment reminder regarding 69 Studio for Rs. 15,000..." required></textarea>

            <button type="submit">Schedule Reminder 🚀</button>
        </form>

        <h2>📋 Pending Reminders (${pendingReminders.length})</h2>
        <div id="remList">
            ${pendingReminders.length === 0 ? '<p style="text-align:center;">No pending reminders right now.</p>' : 
                pendingReminders.map(r => `
                    <div class="rem-item">
                        <div>
                            <strong>+${r.phone}</strong> — <em>${new Date(r.time).toLocaleString()}</em><br>
                            <span style="color:#8696a0;">"${r.message}"</span>
                        </div>
                        <button class="del-btn" onclick="cancelRem('${r.id}')">Cancel</button>
                    </div>
                `).join('')}
        </div>
    </div>

    <script>
        document.getElementById('remForm').onsubmit = async (e) => {
            e.preventDefault();
            const phone = document.getElementById('remPhone').value;
            const time = document.getElementById('remTime').value;
            const message = document.getElementById('remMsg').value;

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
                                        `📅 *Date & Time:* ${scheduledDate.toLocaleString()}\n` +
                                        `💬 *Message:* "${rawMsg}"\n` +
                                        `🆔 *ID:* \`${newRem.id}\`\n\n` +
                                        `_Olivia will automatically send this message at the scheduled time!_ ⏰`;

                    await sock.sendMessage(from, { text: confirmText }, { quoted: msg });
                    console.log(`📅 Reminder scheduled for +${phone} at ${scheduledDate.toLocaleString()}`);
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
                                        `⏱️ ${new Date(r.time).toLocaleString()}\n` +
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
            }

            // Ignore messages sent by Owner for auto-reply
            if (isOwner) continue;

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
