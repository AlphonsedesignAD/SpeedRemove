import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.REMOVE_BG_API_KEY;
const SIZE = process.env.REMOVE_BG_SIZE || 'auto';
const MAX_PER_HOUR = Math.max(1, Number(process.env.MAX_REQUESTS_PER_HOUR || 30));
const MAX_BYTES = 10 * 1024 * 1024;
const startedRequests = [];
const perMinute = new Map();
let active = 0;

function allowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const allowed = new Set([
    `https://${req.headers.host}`,
    'https://speed-remove.vercel.app'
  ]);
  if (process.env.PUBLIC_ORIGIN) allowed.add(process.env.PUBLIC_ORIGIN.replace(/\/$/, ''));
  return allowed.has(origin);
}

function json(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(value));
}

async function readBody(req, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw Object.assign(new Error('Image trop volumineuse. Limite : 10 Mo.'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function rateLimited(req) {
  const now = Date.now();
  while (startedRequests.length && now - startedRequests[0] > 3600000) startedRequests.shift();
  if (startedRequests.length >= MAX_PER_HOUR) return true;
  const ip = req.socket.remoteAddress || 'unknown';
  const recent = (perMinute.get(ip) || []).filter(t => now - t < 60000);
  if (recent.length >= 5) return true;
  recent.push(now);
  perMinute.set(ip, recent);
  startedRequests.push(now);
  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      if (!allowedOrigin(req)) return json(res, 403, { error: 'Origine non autorisée.' });
      res.writeHead(204, { 'Access-Control-Allow-Origin': req.headers.origin || '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' });
      return res.end();
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, service: 'SpeedRemove' }));
    }

    if (req.method === 'POST' && url.pathname === '/api/remove-background') {
      if (!allowedOrigin(req)) return json(res, 403, { error: 'Origine non autorisée.' });
      if (!API_KEY) return json(res, 503, { error: 'Le service de détourage n’est pas configuré.' });
      if (rateLimited(req)) return json(res, 429, { error: 'Limite de demandes atteinte. Réessayez plus tard.' });
      if (active >= 3) return json(res, 429, { error: 'Le service est occupé. Réessayez dans un instant.' });
      if (!String(req.headers['content-type'] || '').includes('multipart/form-data')) return json(res, 400, { error: 'Envoyez une image au format JPG, PNG ou WebP.' });

      active++;
      try {
        const bytes = await readBody(req, MAX_BYTES + 65536);
        const request = new Request('http://localhost/upload', {
          method: 'POST',
          headers: { 'content-type': req.headers['content-type'] },
          body: bytes
        });
        const incoming = await request.formData();
        const file = incoming.get('image_file');
        if (!file || typeof file.arrayBuffer !== 'function') return json(res, 400, { error: 'Aucune image reçue.' });
        if (file.size < 1 || file.size > MAX_BYTES) return json(res, 413, { error: 'La taille de l’image doit être inférieure à 10 Mo.' });
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return json(res, 415, { error: 'Format non pris en charge. Utilisez JPG, PNG ou WebP.' });

        const outgoing = new FormData();
        outgoing.append('image_file', file, file.name || 'image');
        outgoing.append('size', SIZE);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000);
        let apiResponse;
        try {
          apiResponse = await fetch('https://api.remove.bg/v1.0/removebg', {
            method: 'POST',
            headers: { 'X-Api-Key': API_KEY },
            body: outgoing,
            signal: controller.signal
          });
        } finally {
          clearTimeout(timeout);
        }
        if (!apiResponse.ok) {
          let message = 'Le détourage a échoué. Vérifiez votre clé API et vos crédits remove.bg.';
          try {
            const details = await apiResponse.json();
            message = details?.errors?.[0]?.title || message;
          } catch {}
          return json(res, apiResponse.status === 402 ? 402 : 502, { error: message });
        }
        const result = Buffer.from(await apiResponse.arrayBuffer());
        res.writeHead(200, {
          'Content-Type': apiResponse.headers.get('content-type') || 'image/png',
          'Content-Length': result.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        });
        return res.end(result);
      } finally {
        active--;
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Méthode non autorisée.' });
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    const filePath = path.resolve(PUBLIC_DIR, '.' + pathname);
    if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) return json(res, 403, { error: 'Accès refusé.' });
    let data;
    try { data = await fs.readFile(filePath); }
    catch { return json(res, 404, { error: 'Page introuvable.' }); }
    const ext = path.extname(filePath).toLowerCase();
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
    return req.method === 'HEAD' ? res.end() : res.end(data);
  } catch (error) {
    console.error('Erreur serveur:', error);
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Erreur interne du serveur.' });
    else res.end();
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`SpeedRemove démarré sur le port ${PORT}`));
