import OpenAI from 'openai';
import 'dotenv/config';

async function testGroq() {
    const key = process.env.GROQ_API_KEY;
    if (!key) {
        console.error('❌ GROQ_API_KEY is missing');
        return;
    }
    const client = new OpenAI({
        apiKey: key,
        baseURL: "https://api.groq.com/openai/v1"
    });

    try {
        const chatCompletion = await client.chat.completions.create({
            messages: [{ role: 'user', content: 'Say hello' }],
            model: 'llama-3.3-70b-versatile',
        });
        console.log('✅ Groq Response:', chatCompletion.choices[0].message.content);
    } catch (e) {
        console.error('❌ Groq API Error:', e.message);
    }
}

testGroq();
