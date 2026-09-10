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

// Global Bot Status for Web Dashboard
let currentStatus = 'initializing';
let lastQR = null;
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
 * Lightweight HTTP Server for Cloud Hosting (Render / Railway)
 */
const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    if (url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'ok', uptime: Math.floor(process.uptime()), bot: BOT_NAME }));
    }

    if (url === '/qr') {
        if (!lastQR) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(`<h2>✅ WhatsApp is already connected! No QR code needed.</h2><p><a href="/">Back to Dashboard</a></p>`);
        }
        res.writeHead(200, { 'Content-Type': 'image/png' });
        const qrStream = qrImage.image(lastQR, { type: 'png', size: 8 });
        return qrStream.pipe(res);
    }

    // Default status dashboard
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const uptimeMin = Math.floor(process.uptime() / 60);
    const html = `<!DOCTYPE html>
<html>
<head>
    <title>${BOT_NAME} - 24/7 Cloud Assistant</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b141a; color: #e9edef; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .card { background: #111b21; border-radius: 16px; padding: 32px; max-width: 440px; width: 90%; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border: 1px solid #222e35; }
        .badge { display: inline-block; padding: 6px 14px; border-radius: 20px; font-weight: 600; font-size: 14px; margin-bottom: 16px; background: #00a884; color: #fff; }
        h1 { margin: 0 0 10px 0; font-size: 24px; color: #00a884; }
        p { color: #8696a0; margin: 8px 0; font-size: 15px; }
        a { color: #53bdeb; text-decoration: none; font-weight: 500; }
        .qr-box { margin-top: 20px; background: #fff; padding: 12px; border-radius: 12px; display: inline-block; }
    </style>
</head>
<body>
    <div class="card">
        <span class="badge">${currentStatus === 'connected' ? '🟢 ONLINE 24/7' : '🟡 ' + currentStatus.toUpperCase()}</span>
        <h1>🤖 ${BOT_NAME}</h1>
        <p>Personal AI Assistant for <strong>${OWNER_NAME}</strong></p>
        <p>⏱️ Uptime: <strong>${uptimeMin} minutes</strong></p>
        <p>🌐 Website: <a href="${MY_WEBSITE}" target="_blank">${MY_WEBSITE}</a></p>
        ${lastQR ? '<div class="qr-box"><img src="/qr" alt="QR Code" width="220"><p style="color:#111;margin:6px 0 0 0;font-size:13px;">Scan with WhatsApp</p></div>' : '<p style="color:#00a884;margin-top:20px;">✨ Active & Auto-Replying to incoming messages!</p>'}
    </div>
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
    }, 10 * 60 * 1000); // Every 10 minutes
}

/**
 * Start the WhatsApp Bot
 */
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion();

    console.log(`\n========================================`);
    console.log(`🤖 ${BOT_NAME} — ${OWNER_NAME}'s WhatsApp Auto-Reply Bot`);
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
            console.log(`🌐 Website Link: ${MY_WEBSITE}`);
            console.log(`⏱️ Spam Cooldown: ${COOLDOWN_MINUTES} minutes`);
            console.log('========================================\n');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    const botStartTime = Date.now();

    // Incoming Messages
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            // Ignore messages sent by Subhash/Owner
            if (!msg || !msg.message || msg.key.fromMe) continue;

            const from = msg.key.remoteJid || '';

            // 1. STRICTLY IGNORE GROUPS, CHANNELS, BROADCASTS & PARTICIPANTS
            const isGroupOrChannel = from.endsWith('@g.us') || 
                                     from.endsWith('@newsletter') || 
                                     from.includes('@broadcast') || 
                                     !!msg.key.participant;
            if (isGroupOrChannel) continue;

            // Only reply to direct 1-on-1 personal chats
            if (!from.endsWith('@s.whatsapp.net') && !from.endsWith('@lid')) continue;

            const senderNumber = from.replace(/@.*$/, '');
            const senderName = msg.pushName || '';

            // If owner number is texting, don't auto-reply
            if (OWNER_NUMBER && senderNumber.includes(OWNER_NUMBER)) continue;

            // 2. ONLY REPLY TO NEW MESSAGES (Ignore old/synced history)
            const msgTimestampSec = typeof msg.messageTimestamp === 'number' 
                ? msg.messageTimestamp 
                : (msg.messageTimestamp?.low || Number(msg.messageTimestamp) || 0);
            const msgTimeMs = msgTimestampSec * 1000;

            // If message was sent before this bot session started, or is older than 2 minutes, ignore it!
            if (msgTimeMs && (msgTimeMs < botStartTime - 5000 || (Date.now() - msgTimeMs) > 120000)) {
                console.log(`⏩ Skipped old/synced message from ${senderName || senderNumber} (Sent at: ${new Date(msgTimeMs).toLocaleTimeString()})`);
                continue;
            }

            // Extract text message content
            const msgContent = msg.message.ephemeralMessage?.message ||
                               msg.message.viewOnceMessage?.message ||
                               msg.message.viewOnceMessageV2?.message ||
                               msg.message;

            const bodyText = msgContent.conversation ||
                             msgContent.extendedTextMessage?.text ||
                             msgContent.imageMessage?.caption ||
                             '';

            console.log(`📩 New message from ${senderName || senderNumber}: ${bodyText || '[Media/Other]'}`);

            // Check Cooldown to avoid spamming the same person
            const now = Date.now();
            const lastTime = lastReplyMap.get(from) || 0;
            const cooldownMs = COOLDOWN_MINUTES * 60 * 1000;

            if (now - lastTime < cooldownMs) {
                console.log(`⏳ Skipped auto-reply for ${senderName || senderNumber} (Already notified within last ${COOLDOWN_MINUTES} mins).`);
                continue;
            }

            try {
                // 1. Blue Ticks (Mark as read)
                await sleep(500);
                await sock.readMessages([msg.key]);

                // 2. Realistic "typing..." delay
                await sock.sendPresenceUpdate('composing', from);
                await sleep(1500);

                // 3. Prepare response
                let reply = '';
                if (USE_AI && bodyText) {
                    reply = await getSmartAIReply(bodyText, senderName);
                } else {
                    reply = getBusyMessage(senderName);
                }

                // 4. Send Message
                await sock.sendMessage(from, { text: reply }, { quoted: msg });
                lastReplyMap.set(from, now);

                console.log(`✅ Auto-reply sent to ${senderName || senderNumber}!\n`);

                // 5. Stop typing indicator
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
