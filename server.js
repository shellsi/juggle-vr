import https from 'https';
import { readFileSync } from 'fs';
import { createServer } from 'http';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { networkInterfaces } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveFile(req, res) {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = join(__dirname, filePath);

  try {
    const content = readFileSync(filePath);
    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch (err) {
    res.writeHead(404);
    res.end('Not found');
  }
}

// HTTPS server (for Quest / WebXR)
const httpsOptions = {
  key: readFileSync(join(__dirname, 'key.pem')),
  cert: readFileSync(join(__dirname, 'cert.pem')),
};

const httpsServer = https.createServer(httpsOptions, serveFile);
const HTTPS_PORT = 8443;

httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  🤹 Juggle VR — HTTPS Server');
  console.log('  ─────────────────────────────');

  // Show LAN IPs — Quest needs the numeric IP (localhost = headset itself)
  let hasNetwork = false;
  try {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] ?? []) {
        if (net.family === 'IPv4' && !net.internal) {
          console.log(`  Quest:   https://${net.address}:${HTTPS_PORT}  ← use this on headset`);
          hasNetwork = true;
        }
      }
    }
  } catch {
    // Some restricted/sandboxed environments disallow interface enumeration.
  }

  if (!hasNetwork) {
    console.log('  (Run "ipconfig getifaddr en0" to find your LAN IP for Quest)');
  }
  console.log(`  Desktop: https://localhost:${HTTPS_PORT}`);
  console.log('');
  console.log('  ⚠️  Quest will show a certificate warning — tap "Advanced" → "Proceed"');
  console.log('  🎮 Then tap "Enter VR" to start juggling!');
  console.log('');
});

// Also serve HTTP on 3001 for local desktop preview
const httpServer = createServer(serveFile);
httpServer.listen(3001, '0.0.0.0', () => {
  console.log(`  (HTTP fallback on http://localhost:3001)`);
  console.log('');
});
