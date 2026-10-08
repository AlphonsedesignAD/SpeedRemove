import http from 'node:http';
import { readFile } from 'node:fs/promises';

// Configuration : aucune clé API dans ce fichier.
const PORT = Number(process.env.PORT || 3000);
const ON_VERCEL = process.env.VERCEL === '1';

const KEY = process.env.REMOVE_BG_API_KEY?.trim();
const SIZE = process.env.REMOVE_BG_SIZE?.trim() || 'preview';

const MAX_FILE = ON_VERCEL ? 4_000_000 : 10 * 1024 * 1024;
const MAX_BODY = MAX_FILE + 128 * 1024;
const MAX_RESPONSE = ON_VERCEL
  ? 4_000_000
  : 40 * 1024 * 1024;

const FILE_LIMIT_LABEL = ON_VERCEL ? '4 Mo' : '10 Mo';

const configuredBudget = Number(
  process.env.MAX_REQUESTS_PER_HOUR || 30
);

const HOURLY_BUDGET = Number.isFinite(configuredBudget)
  ? Math.max(1, Math.floor(configuredBudget))
  : 30;

// Ces limites sont par instance, pas globales sur Vercel.
const rates = new Map();
let active = 0;
let used = 0;
let usageWindow = Date.now();

function normalizeOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  try {
    const url = new URL(value.trim());

    if (
      ['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

const allowedOrigins = new Set();

function allowOrigin(value) {
  const origin = normalizeOrigin(value);

  if (origin) {
    allowedOrigins.add(origin);
  }
}

// Domaine officiel de votre site.
allowOrigin('https://speed-remove.vercel.app');

// Domaine personnalisé éventuel.
allowOrigin(process.env.PUBLIC_ORIGIN);

// Adresses propres à ce projet Vercel.
// Ne pas autoriser tous les domaines *.vercel.app.
if (ON_VERCEL) {
  for (const host of [
    process.env.VERCEL_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL
  ]) {
    if (host?.trim()) {
      allowOrigin(`https://${host.trim()}`);
    }
  }
} else {
  allowOrigin(`http://localhost:${PORT}`);
  allowOrigin(`http://127.0.0.1:${PORT}`);
}

function isAllowedOrigin(req) {
  const origin = normalizeOrigin(req.headers.origin);
  return origin !== null && allowedOrigins.has(origin);
}

function json(res, status, message) {
  if (res.destroyed || res.writableEnded) {
    return;
  }

  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });

  res.end(JSON.stringify({ error: message }));
}

function looksLikeImage(buffer, type) {
  if (type === 'image/png') {
    return buffer.subarray(0, 8).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    );
  }

  if (type === 'image/jpeg') {
    return (
      buffer[0] === 255 &&
      buffer[1] === 216 &&
      buffer[2] === 255
    );
  }

  if (type === 'image/webp') {
    return (
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP'
    );
  }

  return false;
}

async function readBody(req) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;

    if (total > MAX_BODY) {
      throw Object.assign(
        new Error(`Cette image dépasse ${FILE_LIMIT_LABEL}.`),
        { status: 413 }
      );
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');

  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      'font-src https://fonts.gstatic.com',
      "img-src 'self' blob: data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'"
    ].join('; ')
  );
}

async function servePage(req, res, path) {
  // Sur Vercel, les fichiers public/ sont servis séparément.
  if (ON_VERCEL) {
    if (path === '/') {
      res.writeHead(302, {
        Location: '/index.html',
        'Cache-Control': 'no-store'
      });
      res.end();
      return;
    }

    return json(
      res,
      404,
      'Vérifiez que public/index.html est présent dans le dépôt GitHub.'
    );
  }

  // Lecture uniquement lors d'une requête locale.
  // Aucune lecture HTML au démarrage du serveur.
  try {
    const page = await readFile(
      new URL('./public/index.html', import.meta.url)
    );

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache'
    });

    res.end(req.method === 'HEAD' ? undefined : page);
  } catch {
    return json(
      res,
      500,
      'Le fichier public/index.html est introuvable.'
    );
  }
}

async function handleRequest(req, res) {
  setSecurityHeaders(res);

  const path = (req.url || '/').split('?')[0];

  if (
    ['GET', 'HEAD'].includes(req.method) &&
    ['/', '/index.html'].includes(path)
  ) {
    return servePage(req, res, path);
  }

  if (path === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Permet de vérifier que le serveur démarre,
  // sans exposer la clé ni sa configuration.
  if (path === '/api/health' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });

    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (path !== '/api/remove-background') {
    return json(res, 404, 'Page introuvable.');
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, 'Méthode non autorisée.');
  }

  if (!isAllowedOrigin(req)) {
    console.warn('Origine refusée :', {
      origin: normalizeOrigin(req.headers.origin),
      allowedOrigins: [...allowedOrigins]
    });

    return json(
      res,
      403,
      'Adresse non autorisée. Ouvrez https://speed-remove.vercel.app.'
    );
  }

  if (!KEY) {
    return json(
      res,
      503,
      'La clé remove.bg manque dans les variables du serveur. Ajoutez REMOVE_BG_API_KEY puis redéployez.'
    );
  }

  if (['preview', 'auto', 'full'].includes(SIZE)) {
    return json(
      res,
      503,
      'La variable REMOVE_BG_SIZE doit valoir preview, auto ou full.'
    );
  }

  const contentType = String(
    req.headers['content-type'] || ''
  );

  if (
    !contentType.toLowerCase().startsWith('multipart/form-data;')
  ) {
    return json(res, 400, 'Une image est requise.');
  }

  const contentLength = Number(
    req.headers['content-length'] || 0
  );

  if (contentLength > MAX_BODY) {
    return json(
      res,
      413,
      `Cette image dépasse ${FILE_LIMIT_LABEL}.`
    );
  }

  const now = Date.now();
  const ip = req.socket.remoteAddress || 'unknown';

  // Nettoyage des compteurs expirés, sans minuterie permanente.
  for (const [address, record] of rates) {
    if (now - record.start >= 60_000) {
      rates.delete(address);
    }
  }

  const bucket = rates.get(ip) || {
    start: now,
    count: 0
  };

  if (bucket.count >= 5) {
    res.setHeader('Retry-After', '60');

    return json(
      res,
      429,
      'Trop de demandes. Patientez une minute.'
    );
  }

  bucket.count++;
  rates.set(ip, bucket);

  if (now - usageWindow >= 3_600_000) {
    used = 0;
    usageWindow = now;
  }

  if (used >= HOURLY_BUDGET) {
    return json(
      res,
      429,
      'La limite horaire de cette instance est atteinte.'
    );
  }

  if (active >= 3) {
    return json(
      res,
      503,
      'Le service est occupé. Réessayez dans un instant.'
    );
  }

  active++;

  try {
    const bytes = await readBody(req);
    let formData;

    try {
      formData = await new Request(
        'http://localhost/upload',
        {
          method: 'POST',
          headers: { 'Content-Type': contentType },
          body: bytes
        }
      ).formData();
    } catch {
      return json(
        res,
        400,
        'Le fichier envoyé est invalide.'
      );
    }

    const images = formData.getAll('image_file');
    const file = images[0];

    if (
      images.length !== 1 ||
      !file ||
      typeof file === 'string' ||
      !file.size
    ) {
      return json(
        res,
        400,
        'Choisissez une seule image non vide.'
      );
    }

    if (file.size > MAX_FILE) {
      return json(
        res,
        413,
        `Cette image dépasse ${FILE_LIMIT_LABEL}.`
      );
    }

    if (
      ['image/jpeg', 'image/png', 'image/webp'].includes(file.type)
    ) {
      return json(
        res,
        415,
        'Choisissez une image JPG, PNG ou WebP.'
      );
    }

    const image = Buffer.from(await file.arrayBuffer());

    if (!looksLikeImage(image, file.type)) {
      return json(
        res,
        415,
        'Le contenu du fichier ne correspond pas au format annoncé.'
      );
    }

    // Seuls les paramètres choisis par le serveur sont transmis.
    const upstreamForm = new FormData();

    upstreamForm.append(
      'image_file',
      new Blob([image], { type: file.type }),
      'image'
    );

    upstreamForm.append('size', SIZE);
    upstreamForm.append('format', 'png');

    used++;

    const upstream = await fetch(
      'https://api.remove.bg/v1.0/removebg',
      {
        method: 'POST',
        headers: { 'X-Api-Key': KEY },
        body: upstreamForm,
        signal: AbortSignal.timeout(55_000)
      }
    );

    if (!upstream.ok) {
      console.warn('Statut remove.bg :', upstream.status);
      await upstream.body?.cancel();

      const messages = {
        400: 'Cette image ne peut pas être traitée. Essayez une autre photo.',
        402: 'Le compte remove.bg n’a plus assez de crédits.',
        403: 'La clé remove.bg est invalide ou désactivée.',
        429: 'remove.bg reçoit trop de demandes. Réessayez plus tard.'
      };

      const status = [400, 402, 429].includes(upstream.status)
        ? upstream.status
        : 502;

      return json(
        res,
        status,
        messages[upstream.status] ||
          'Le service de détourage est indisponible.'
      );
    }

    if (
      !upstream.headers.get('content-type')?.startsWith('image/png')
    ) {
      await upstream.body?.cancel();

      return json(
        res,
        502,
        'Réponse inattendue du service de détourage.'
      );
    }

    if (!upstream.body) {
      return json(res, 502, 'Le service a renvoyé une réponse vide.');
    }

    const chunks = [];
    let total = 0;

    for await (const chunk of upstream.body) {
      total += chunk.length;

      if (total > MAX_RESPONSE) {
        throw Object.assign(
          new Error(
            ON_VERCEL
              ? 'Le PNG obtenu dépasse la limite de 4 Mo de cette version. Essayez une photo de dimensions plus petites.'
              : 'Le résultat est trop volumineux.'
          ),
          { status: 413 }
        );
      }

      chunks.push(chunk);
    }

    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Disposition':
        'attachment; filename="speedremove.png"',
      'Cache-Control': 'no-store'
    });

    res.end(Buffer.concat(chunks));
  } finally {
    active--;
  }
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(error => {
    // Ne pas enregistrer la clé, le corps de requête ou les photos.
    console.error('Erreur serveur :', {
      name: error.name,
      status: error.status || null
    });

    const timedOut = ['AbortError', 'TimeoutError'].includes(
      error.name
    );

    json(
      res,
      error.status || (timedOut ? 504 : 502),
      error.status
        ? error.message
        : timedOut
          ? 'Le traitement a pris trop de temps. Réessayez.'
          : 'Une erreur serveur est survenue. Consultez les Logs Vercel.'
    );
  });
});

server.requestTimeout = 70_000;
server.headersTimeout = 15_000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SpeedRemove : http://localhost:${PORT}`);
});