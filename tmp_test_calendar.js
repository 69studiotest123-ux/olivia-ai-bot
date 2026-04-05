import { google } from 'googleapis';
import 'dotenv/config';

async function testCalendar() {
    console.log('🚀 Final Access Check...');
    
    let rawKey = process.env.GOOGLE_PRIVATE_KEY;
    if (!rawKey) {
        console.error('❌ KEY MISSING');
        return;
    }
    
    // STRIP EXTRA QUOTES IF ANY
    if (rawKey.startsWith('"') && rawKey.endsWith('"')) {
        rawKey = rawKey.substring(1, rawKey.length - 1);
    }
    
    const privateKey = rawKey.replace(/\\n/g, '\n');

    try {
        const auth = new google.auth.JWT({
            email: process.env.GOOGLE_CLIENT_EMAIL,
            key: privateKey,
            scopes: ['https://www.googleapis.com/auth/calendar']
        });

        console.log('📡 Accessing Google APIs...');
        await auth.authorize();
        
        const calendar = google.calendar({ version: 'v3', auth });
        const calendarId = process.env.GOOGLE_CALENDAR_ID;

        const res = await calendar.events.insert({
            calendarId: calendarId,
            resource: {
                summary: '🏆 Olivia: Final Connection Confirmed!',
                description: 'Syncing with Google Calendar successful.',
                start: { dateTime: new Date().toISOString(), timeZone: 'Asia/Colombo' },
                end: { dateTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(), timeZone: 'Asia/Colombo' },
            },
        });

        console.log('✅ SUCCESS! Access Verified.');
        console.log('Link:', res.data.htmlLink);
    } catch (error) {
        console.error('❌ Final Failure:', error.message);
    }
}

testCalendar();
