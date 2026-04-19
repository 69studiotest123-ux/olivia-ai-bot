import { GoogleGenerativeAI } from '@google/generative-ai';
import 'dotenv/config';

async function testGemini() {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
        console.error('❌ GEMINI_API_KEY is missing in .env');
        return;
    }
    console.log(`? Testing Gemini with key: ${key.substring(0, 5)}...`);
    try {
        const genAI = new GoogleGenerativeAI(key);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent("Hello, are you working?");
        const response = await result.response;
        const text = response.text();
        console.log('✅ Gemini Response:', text);
    } catch (e) {
        console.error('❌ Gemini API Error:', e.message);
    }
}

testGemini();
