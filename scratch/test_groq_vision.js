import OpenAI from 'openai';
import 'dotenv/config';

async function testGroqVision() {
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
            messages: [{ 
                role: 'user', 
                content: [
                    { type: "text", text: "What's in this image?" },
                    { type: "image_url", image_url: { url: "https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/Gnome-set-as-desktop-background.svg/1200px-Gnome-set-as-desktop-background.svg.png" } }
                ]
            }],
            model: 'llama-3.2-11b-vision-preview',
        });
        console.log('✅ Groq Vision Response:', chatCompletion.choices[0].message.content);
    } catch (e) {
        console.error('❌ Groq Vision Error:', e.message);
    }
}

testGroqVision();
