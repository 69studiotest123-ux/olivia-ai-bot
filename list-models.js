import { GoogleGenerativeAI } from '@google/generative-ai';
import 'dotenv/config';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function listModels() {
    try {
        console.log('Fetching available models...');
        // Note: The actual method name might be listModels
        const models = await genAI.getGenerativeModel({ model: "gemini-pro" }); 
        // Actually, just try one common 2026 name
        console.log('Testing gemini-2.0-flash-exp...');
    } catch (e) {
        console.error('Error fetching list:', e.message);
    }
}

listModels();
