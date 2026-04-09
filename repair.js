const fs = require('fs');
const path = 'c:/Users/Subhash Ketagoda/OneDrive/Desktop/Ai Bots/Olivia-App/public/index.html';

let content = fs.readFileSync(path, 'utf8');

// 1. Update Version
content = content.replace(/v7\.2/g, 'v7.3');

// 2. Remove Syntax Garbage
const garbageRegex = /st\.remove\('thinking-shimmer'\);\s*aiTextEl\.innerText = 'Connection error\. Please try again\.'\s*\}\s*\}/g;
content = content.replace(garbageRegex, '');

// 3. Fix System Prompt (Clean up between Persona Identity and Memory)
const startMarker = "const SYSTEM_PROMPT = `You are Subhash's loyal, smart and charming AI Personal Assistant named Olivia.";
const endMarker = "MEMORY SYSTEM:";

const startIdx = content.indexOf(startMarker);
const endIdx = content.indexOf(endMarker);

if (startIdx !== -1 && endIdx !== -1) {
    const newContext = `You are Subhash's loyal, smart and charming AI Personal Assistant named Olivia. 
    
    CRITICAL IDENTITY:
    - You are talking directly to Subhash, your boss and creator.
    - NEVER ask for his name or purpose. 
    - NEVER provide the appointment link (that is only for new WhatsApp leads).
    - Be helpful, witty, and concise.

    Language Rules:
    - Detect the language (English or Singlish).
    - NEVER use Sinhala script (අ ආ...).

    `;
    content = content.substring(0, startIdx) + "const SYSTEM_PROMPT = `" + newContext + content.substring(endIdx);
    console.log("✅ SYSTEM_PROMPT Updated!");
} else {
    console.log("❌ Could not find systemic markers");
}

fs.writeFileSync(path, content);
console.log("✅ index.html Cleaned Successfully!");
