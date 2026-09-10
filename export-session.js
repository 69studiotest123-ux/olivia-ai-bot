import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authFolder = path.join(__dirname, 'auth_info_baileys');
const outputFile = path.join(__dirname, 'session_export.txt');

if (!fs.existsSync(authFolder) || fs.readdirSync(authFolder).length === 0) {
    console.error('❌ Error: auth_info_baileys folder is empty or does not exist!');
    console.error('Please scan the QR code first using "npm start" before exporting session.');
    process.exit(1);
}

try {
    const files = fs.readdirSync(authFolder);
    const bundle = {};

    for (const file of files) {
        const fullPath = path.join(authFolder, file);
        if (fs.statSync(fullPath).isFile()) {
            bundle[file] = fs.readFileSync(fullPath, 'utf8');
        }
    }

    const jsonString = JSON.stringify(bundle);
    const compressed = zlib.gzipSync(Buffer.from(jsonString, 'utf8'));
    const sessionString = compressed.toString('base64');

    fs.writeFileSync(outputFile, sessionString);

    console.log('\n======================================================');
    console.log('🎉 SESSION EXPORTED SUCCESSFULLY FOR 24/7 CLOUD HOSTING!');
    console.log('======================================================\n');
    console.log('📋 Instructions for Render / Cloud:');
    console.log('1. Go to your Render Web Service Environment settings.');
    console.log('2. Add a new Environment Variable:');
    console.log('   KEY   : SESSION_DATA');
    console.log('   VALUE : (Copy the long text from session_export.txt)');
    console.log('\n💾 The session string has been saved to: session_export.txt');
    console.log(`📏 String length: ${sessionString.length} characters (Bundled ${files.length} auth files)\n`);
} catch (e) {
    console.error('❌ Export failed:', e.message);
    process.exit(1);
}
