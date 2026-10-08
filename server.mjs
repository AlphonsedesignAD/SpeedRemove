import http from 'node:http';
import { readFile } from 'node:fs/promises';

// Configuration
const PORT = Number(process.env.PORT || 3000);
const KEY = process.env.REMOVE_BG_API_KEY?.trim();
const size = process.env.REMOVE_BG_SIZE?.trim() || 'preview';
const onVercel = process.env.VERCEL === '1';

const MAX_FILE = onVercel
  ? 4_000_000
  : 10 * 1024 * 1024;

const MAX_BODY = MAX_FILE + 128 * 1024;

// Marge sous la limite des réponses non streamées de Vercel.
const MAX_RESPONSE = onVercel
  ? 4_000_000
  : 40 * 1024 * 1024;

const fileLimitLabel = onVercel ? '4 Mo' : '10 Mo';

const page = await readFile(
  new URL('./public/index.html', import.meta.url)
);

if (!KEY) {
  throw new Error(
    'La variable REMOVE_BG_API_KEY est manquante.'
  );
}

if (['preview', 'auto', 'full'].includes(size)) {
  throw new Error(
    'REMOVE_BG_SIZE doit valoir preview, auto ou full.'
  );
}

const requestedBudget = Number(
  process.env.MAX_REQUESTS_PER_HOUR || 30
);

const hourlyBudget = Number.isFinite(requestedBudget)
  ? Math.max(1, Math.floor(requestedBudget))
  : 30;

// Comparaison d'origines normalisées.
// Un slash final ou un espace dans PUBLIC_ORIGIN ne bloque plus.
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

function addAllowedOrigin(value) {
  const origin = normalizeOrigin(value);

  if (origin) {
    allowedOrigins.add(origin);
  }
}

// Domaine public connu de SpeedRemove.
addAllowedOrigin('https://speed-remove.vercel.app');

// Domaine personnalisé éventuellement configuré.
addAllowedOrigin(process.env.PUBLIC_ORIGIN);

// Adresses attribuées à CE projet par Vercel.
// On n'autorise pas tous les domaines *.vercel.app.
for (const hostname of [
  process.env.VERCEL_URL,
  process.env.VERCEL_PROJECT_PRODUCTION_URL
]) {
  if (hostname?.trim()) {
    addAllowedOrigin(`https://${hostname.trim()}`);
  }
}

// Développement local uniquement.
if (!onVercel) {
  addAllowedOrigin(`http://localhost:${PORT}`);
  addAllowedOrigin(`http://127.0.0.1:${PORT}`);
}

function sameOrigin(req) {
  const origin = normalizeOrigin(req.headers.origin);

  // Les requêtes sans Origin sont refusées.
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

async function bodyBytes(req) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;

    if (total > MAX_BODY) {
      throw Object.assign(
        new Error(`Cette image dépasse ${fileLimitLabel}.`),
        { status: 413 }
      );
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

// Compteurs temporaires, propres à chaque instance.
// Sur Vercel, ils ne constituent PAS un quota global.
const rates = new Map();
let active = 0;
let used = 0;
let usageWindow = Date.now();

setInterval(() => {
  const now = Date.now();

  for (const [ip, record] of rates) {
    if (now - record.start > 60_000) {
      rates.delete(ip);
    }
  }
}, 60_000).unref();

const server = http.createServer(async (req, res) => {
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

  const path = (req.url || '/').split('?')[0];

  if (
    ['GET', 'HEAD'].includes(req.method) &&
    ['/', '/index.html'].includes(path)
  ) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache'
    });

    res.end(req.method === 'HEAD' ? undefined : page);
    return;
  }

  if (path === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (path !== '/api/remove-background') {
    return json(res, 404, 'Page introuvable.');
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, 'Méthode non autorisée.');
  }

  if (!sameOrigin(req)) {
    // Aucun secret ni contenu de photo dans les logs.
    console.warn('Origine refusée :', {
      origin: normalizeOrigin(req.headers.origin),
      allowedOrigins: [...allowedOrigins]
    });

    return json(
      res,
      403,
      'Adresse du site non autorisée. Ouvrez SpeedRemove depuis son domaine officiel.'
    );
  }

  const contentType = String(
    req.headers['content-type'] || ''
  );

  if (
    !contentType.toLowerCase().startsWith(
      'multipart/form-data;'
    )
  ) {
    return json(res, 400, 'Une image est requise.');
  }

  const length = Number(
    req.headers['content-length'] || 0
  );

  if (length > MAX_BODY) {
    return json(
      res,
      413,
      `Cette image dépasse ${fileLimitLabel}.`
    );
  }

  // Ne pas faire confiance à un X-Forwarded-For arbitraire.
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const bucket = rates.get(ip) || {
    start: now,
    count: 0
  };

  if (now - bucket.start > 60_000) {
    bucket.start = now;
    bucket.count = 0;
  }

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

  if (used >= hourlyBudget) {
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
    const bytes = await bodyBytes(req);
    let data;

    try {
      data = await new Request(
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

    const images = data.getAll('image_file');
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
        `Cette image dépasse ${fileLimitLabel}.`
      );
    }

    if (
      ['image/jpeg', 'image/png', 'image/webp']
        .includes(file.type)
    ) {
      return json(
        res,
        415,
        'Choisissez une image JPG, PNG ou WebP.'
      );
    }

    const image = Buffer.from(
      await file.arrayBuffer()
    );

    if (!looksLikeImage(image, file.type)) {
      return json(
        res,
        415,
        'Le contenu du fichier ne correspond pas au format annoncé.'
      );
    }

    const form = new FormData();

    form.append(
      'image_file',
      new Blob([image], { type: file.type }),
      'image'
    );

    form.append('size', size);
    form.append('format', 'png');

    used++;

    const upstream = await fetch(
      'https://api.remove.bg/v1.0/removebg',
      {
        method: 'POST',
        headers: { 'X-Api-Key': KEY },
        body: form,
        signal: AbortSignal.timeout(55_000)
      }
    );

    if (!upstream.ok) {
      console.warn(
        'Erreur remove.bg, statut :',
        upstream.status
      );

      await upstream.body?.cancel();

      const messages = {
        400: 'Cette image ne peut pas être traitée. Essayez une autre photo.',
        402: 'Le compte remove.bg n’a plus assez de crédits.',
        403: 'La clé remove.bg est invalide ou désactivée.',
        429: 'remove.bg reçoit trop de demandes. Réessayez plus tard.'
      };

      const status = [400, 402, 429].includes(
        upstream.status
      )
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
      !upstream.headers
        .get('content-type')
        ?.startsWith('image/png')
    ) {
      await upstream.body?.cancel();

      return json(
        res,
        502,
        'Réponse inattendue du service de détourage.'
      );
    }

    const chunks = [];
    let total = 0;

    for await (const chunk of upstream.body) {
      total += chunk.length;

      if (total > MAX_RESPONSE) {
        throw Object.assign(
          new Error(
            onVercel
              ? 'Le PNG obtenu dépasse la taille autorisée par cette version hébergée sur Vercel. Essayez une image de dimensions plus petites.'
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
  } catch (error) {
    if (res.destroyed || res.writableEnded) {
      return;
    }

    console.error(
      'Traitement interrompu :',
      error.name,
      error.status || ''
    );

    const timedOut = [
      'AbortError',
      'TimeoutError'
    ].includes(error.name);

    json(
      res,
      error.status || (timedOut ? 504 : 502),
      error.status
        ? error.message
        : timedOut
          ? 'Le traitement a pris trop de temps. Réessayez.'
          : 'La connexion au service de détourage a échoué.'
    );
  } finally {
    active--;
  }
});

server.requestTimeout = 70_000;
server.headersTimeout = 15_000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SpeedRemove : http://localhost:${PORT}`);
});