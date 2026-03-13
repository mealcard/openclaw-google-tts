import fs from 'node:fs/promises';
import path from 'node:path';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) {
  console.error('Missing GOOGLE_API_KEY');
  process.exit(1);
}

const outDir = new URL('../out/', import.meta.url);
await fs.mkdir(outDir, { recursive: true });

const res = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-goog-api-key': apiKey,
  },
  body: JSON.stringify({
    input: { text: 'hello from google tts' },
    voice: { languageCode: 'en-US', name: 'en-US-Neural2-F' },
    audioConfig: { audioEncoding: 'MP3' }
  })
});

if (!res.ok) {
  console.error(await res.text());
  process.exit(1);
}

const data = await res.json();
const outPath = path.join(new URL('../out/', import.meta.url).pathname, 'test.mp3');
await fs.writeFile(outPath, Buffer.from(data.audioContent, 'base64'));
console.log(outPath);
