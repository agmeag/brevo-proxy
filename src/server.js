import { createServer as createHttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const DEFAULT_BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const MAX_BODY_SIZE_BYTES = 1024 * 1024;

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 20);

// After this many rate-limit violations within the window the IP is blacklisted
const BLACKLIST_THRESHOLD = Number(process.env.BLACKLIST_THRESHOLD ?? 5);
const BLACKLIST_DURATION_MS = Number(process.env.BLACKLIST_DURATION_MS ?? 10 * 60_000); // 10 min

// Max simultaneous open connections before new ones are dropped
const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS ?? 100);

// How long a client has to send the request headers (slow-loris defence)
const HEADERS_TIMEOUT_MS = Number(process.env.HEADERS_TIMEOUT_MS ?? 5_000);

// Drop idle keep-alive connections after this many ms
const KEEP_ALIVE_TIMEOUT_MS = Number(process.env.KEEP_ALIVE_TIMEOUT_MS ?? 30_000);

const rateLimitMap = new Map();  // ip → { windowStart, count, violations }
const blacklistMap = new Map();  // ip → expiresAt

function getIp(request) {
  return request.headers['x-forwarded-for']?.split(',')[0].trim() ?? request.socket.remoteAddress;
}

function isBlacklisted(ip) {
  const expiresAt = blacklistMap.get(ip);
  if (!expiresAt) return false;
  if (Date.now() >= expiresAt) {
    blacklistMap.delete(ip);
    return false;
  }
  return true;
}

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { windowStart: now, count: 1, violations: entry?.violations ?? 0 });
    return false;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    entry.violations++;
    if (entry.violations >= BLACKLIST_THRESHOLD) {
      blacklistMap.set(ip, now + BLACKLIST_DURATION_MS);
      rateLimitMap.delete(ip);
    }
    return true;
  }

  entry.count++;
  return false;
}

// Prune expired entries every minute to prevent unbounded memory growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) rateLimitMap.delete(ip);
  }
  for (const [ip, expiresAt] of blacklistMap) {
    if (now >= expiresAt) blacklistMap.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

function writeCorsHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', process.env.CORS_ALLOW_ORIGIN || '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE_BYTES) {
        reject(new Error('Request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    request.on('error', reject);
  });
}

function send(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(payload);
}

export function createServer() {
  const server = createHttpServer(async (request, response) => {
    writeCorsHeaders(response);

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    // Block blacklisted IPs and rate-limited IPs before doing any other work
    const ip = getIp(request);
    if (isBlacklisted(ip)) {
      send(response, 403, { error: 'Forbidden' });
      return;
    }
    if (isRateLimited(ip)) {
      send(response, 429, { error: 'Too many requests, slow down' });
      return;
    }

    // Auth — only enforced when PROXY_SECRET is configured
    const proxySecret = process.env.PROXY_SECRET;
    if (proxySecret) {
      const key = request.headers['x-proxy-key'];
      if (!key || key !== proxySecret) {
        send(response, 401, { error: 'Unauthorized' });
        return;
      }
    }

    if (request.url !== '/send-transactional-email') {
      send(response, 404, { error: 'Not found' });
      return;
    }

    if (request.method !== 'POST') {
      send(response, 405, { error: 'Method not allowed' });
      return;
    }

    if (!process.env.BREVO_API_KEY) {
      send(response, 500, { error: 'Proxy is not configured' });
      return;
    }

    let bodyText;
    try {
      bodyText = await readRequestBody(request);
    } catch (err) {
      const tooLarge = err.message === 'Request body too large';
      send(response, tooLarge ? 413 : 400, { error: tooLarge ? 'Request payload too large' : 'Failed to read request body' });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      send(response, 400, { error: 'Invalid JSON payload' });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const brevoResponse = await fetch(process.env.BREVO_API_BASE_URL || DEFAULT_BREVO_API_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'api-key': process.env.BREVO_API_KEY,
        },
        body: JSON.stringify(payload),
      });

      const responseBody = await brevoResponse.text();
      response.writeHead(brevoResponse.status, {
        'Content-Type': brevoResponse.headers.get('content-type') || 'application/json',
      });
      response.end(responseBody);
    } catch (err) {
      if (err.name === 'AbortError') {
        send(response, 504, { error: 'Brevo did not respond in time' });
        return;
      }
      console.error('Brevo unreachable:', err.message);
      send(response, 502, { error: 'Unable to reach Brevo API' });
    } finally {
      clearTimeout(timeout);
    }
  });

  server.maxConnections = MAX_CONNECTIONS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;

  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Load .env only for local development — in production (Coolify) vars are injected by the runtime
  if (process.env.NODE_ENV !== 'production') {
    const { default: dotenv } = await import('dotenv');
    dotenv.config();
  }

  const PORT = Number(process.env.PORT || 3000);
  createServer().listen(PORT, () => {
    console.log(`brevo-proxy listening on port ${PORT}`);
  });
}
