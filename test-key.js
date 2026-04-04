import { GoogleGenerativeAI } from '@google/generative-ai';
import 'dotenv/config';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function testKey() {
    try {
        console.log('Testing API key with gemini-2.0-flash...');
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const result = await model.generateContent("Say 'Hello'");
        const response = await result.response;
        console.log('Response:', response.text());
        console.log('--- API KEY IS VALID ---');
    } catch (e) {
        console.error('API Error:', e.message);
        console.log('--- YOUR API KEY IS INVALID OR EXPIRED ---');
        console.log('Please get a new key from https://aistudio.google.com/app/apikey');
    }
}

testKey();
