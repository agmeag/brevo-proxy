import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';

const { BREVO_API_KEY, PROXY_SECRET, PORT = '3000' } = process.env;

if (!BREVO_API_KEY) throw new Error('BREVO_API_KEY is required');
if (!PROXY_SECRET) throw new Error('PROXY_SECRET is required');

const app = express();
app.use(express.json());

function requireProxyKey(req, res, next) {
  const key = req.headers['x-proxy-key'];
  if (!key || key !== PROXY_SECRET) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  next();
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/v3/smtp/email', requireProxyKey, async (req, res) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'api-key': BREVO_API_KEY,
      },
      body: JSON.stringify(req.body),
    });

    const payload = await brevoRes.text();
    res.status(brevoRes.status).set('Content-Type', 'application/json').send(payload);
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ message: 'Gateway timeout: Brevo did not respond in time' });
    }
    console.error('Brevo unreachable:', err.message);
    res.status(502).json({ message: 'Bad gateway: could not reach Brevo' });
  } finally {
    clearTimeout(timeout);
  }
});

app.listen(Number(PORT), () => {
  console.log(`brevo-proxy listening on port ${PORT}`);
});
