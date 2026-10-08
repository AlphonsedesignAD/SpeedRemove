function sameOrigin(req) {
  function normalize(value) {
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

  const allowed = new Set([
    'https://speed-remove.vercel.app'
  ]);

  const configured = normalize(process.env.PUBLIC_ORIGIN);
  if (configured) allowed.add(configured);

  if (process.env.VERCEL === '1') {
    for (const host of [
      process.env.VERCEL_URL,
      process.env.VERCEL_PROJECT_PRODUCTION_URL
    ]) {
      const origin = normalize(
        host ? `https://${host.trim()}` : ''
      );

      if (origin) allowed.add(origin);
    }
  } else {
    allowed.add(`http://localhost:${PORT}`);
    allowed.add(`http://127.0.0.1:${PORT}`);
  }

  const received = normalize(req.headers.origin);
  const accepted = received !== null && allowed.has(received);

  if (!accepted) {
    console.warn('Origine refusée :', {
      origin: received,
      allowedOrigins: [...allowed]
    });
  }

  return accepted;
}