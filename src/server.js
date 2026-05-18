import { createServer as createHttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const DEFAULT_BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const MAX_BODY_SIZE_BYTES = 1024 * 1024;

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

export function createServer() {
  return createHttpServer(async (request, response) => {
    writeCorsHeaders(response);

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.url !== '/send-transactional-email') {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    if (request.method !== 'POST') {
      response.writeHead(405, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    if (!process.env.BREVO_API_KEY) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Proxy is not configured' }));
      return;
    }

    let bodyText;
    try {
      bodyText = await readRequestBody(request);
    } catch {
      response.writeHead(413, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Request payload too large' }));
      return;
    }

    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Invalid JSON payload' }));
      return;
    }

    try {
      const brevoResponse = await fetch(process.env.BREVO_API_BASE_URL || DEFAULT_BREVO_API_URL, {
        method: 'POST',
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
    } catch {
      response.writeHead(502, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Unable to reach Brevo API' }));
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { default: dotenv } = await import('dotenv');
  dotenv.config();

  const PORT = Number(process.env.PORT || 3000);
  createServer().listen(PORT, () => {
    console.log(`brevo-proxy listening on port ${PORT}`);
  });
}
