const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createServer } = require('../src/server');

async function startServer(server) {
  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function captureEnv(name) {
  return Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : undefined;
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

function snapshotBrevoEnv() {
  return {
    BREVO_API_KEY: captureEnv('BREVO_API_KEY'),
    BREVO_API_BASE_URL: captureEnv('BREVO_API_BASE_URL'),
  };
}

function restoreBrevoEnv(snapshot) {
  restoreEnv('BREVO_API_KEY', snapshot.BREVO_API_KEY);
  restoreEnv('BREVO_API_BASE_URL', snapshot.BREVO_API_BASE_URL);
}

test('forwards transactional email requests to Brevo with api key header', async () => {
  const forwarded = {};

  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }

    forwarded.method = req.method;
    forwarded.url = req.url;
    forwarded.apiKey = req.headers['api-key'];
    forwarded.body = Buffer.concat(chunks).toString('utf8');

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ messageId: 'abc-123' }));
  });

  const upstreamUrl = await startServer(upstream);

  const originalEnv = snapshotBrevoEnv();

  process.env.BREVO_API_KEY = 'secret-brevo-key';
  process.env.BREVO_API_BASE_URL = `${upstreamUrl}/v3/smtp/email`;

  const proxy = createServer();
  const proxyUrl = await startServer(proxy);

  const payload = {
    sender: { email: 'noreply@example.com' },
    to: [{ email: 'user@example.com' }],
    subject: 'hello',
    htmlContent: '<p>Hi</p>',
  };

  const response = await fetch(`${proxyUrl}/send-transactional-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { messageId: 'abc-123' });
  assert.equal(forwarded.method, 'POST');
  assert.equal(forwarded.url, '/v3/smtp/email');
  assert.equal(forwarded.apiKey, 'secret-brevo-key');
  assert.deepEqual(JSON.parse(forwarded.body), payload);

  await new Promise((resolve) => proxy.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));

  restoreBrevoEnv(originalEnv);
});

test('returns 500 when BREVO_API_KEY is missing', async () => {
  const originalEnv = snapshotBrevoEnv();
  delete process.env.BREVO_API_KEY;

  const proxy = createServer();
  const proxyUrl = await startServer(proxy);

  const response = await fetch(`${proxyUrl}/send-transactional-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ test: true }),
  });

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Proxy is not configured' });

  await new Promise((resolve) => proxy.close(resolve));

  restoreBrevoEnv(originalEnv);
});

test('returns 400 for invalid JSON body', async () => {
  const originalEnv = snapshotBrevoEnv();
  process.env.BREVO_API_KEY = 'configured-key';

  const proxy = createServer();
  const proxyUrl = await startServer(proxy);

  const response = await fetch(`${proxyUrl}/send-transactional-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{invalid json',
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Invalid JSON payload' });

  await new Promise((resolve) => proxy.close(resolve));

  restoreBrevoEnv(originalEnv);
});
