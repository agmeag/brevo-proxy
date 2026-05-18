# brevo-proxy

Thin HTTP proxy that receives requests from a Lovable frontend and forwards them to [Brevo's transactional email API](https://developers.brevo.com/reference/sendtransacemail). The real Brevo API key never leaves the server.

## How it works

```
Lovable edge function
  POST /send-transactional-email
  x-proxy-key: <PROXY_SECRET>
        │
        ▼
  brevo-proxy (this server)
  1. checks blacklist / rate limit
  2. validates x-proxy-key
  3. forwards body unchanged, injects api-key header
        │
        ▼
  api.brevo.com/v3/smtp/email
  returns response unchanged
```

## Environment variables

### Required

| Variable | Description |
|---|---|
| `BREVO_API_KEY` | Your Brevo API key — never exposed to the frontend |
| `PROXY_SECRET` | Shared secret Lovable sends as `x-proxy-key` header |

### Optional

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |
| `RATE_LIMIT_MAX` | `20` | Max requests per IP per minute before returning 429 |
| `BLACKLIST_THRESHOLD` | `5` | Rate-limit violations before an IP is blacklisted |
| `BLACKLIST_DURATION_MS` | `600000` | How long a blacklisted IP is blocked in ms (default 10 min) |
| `MAX_CONNECTIONS` | `100` | Max simultaneous open connections — excess are dropped at socket level |
| `HEADERS_TIMEOUT_MS` | `5000` | Time a client has to send request headers in ms (slow-loris defence) |
| `KEEP_ALIVE_TIMEOUT_MS` | `30000` | Idle keep-alive connection timeout in ms |

## Security

The proxy applies several layers of protection with no external dependencies:

| Layer | Mechanism |
|---|---|
| **Authentication** | Every request must include `x-proxy-key: <PROXY_SECRET>` — wrong or missing key returns 401 |
| **Rate limiting** | Max `RATE_LIMIT_MAX` requests per IP per minute — excess return 429 |
| **IP blacklisting** | An IP that hits the rate limit `BLACKLIST_THRESHOLD` times is blocked for `BLACKLIST_DURATION_MS` — returns 403 |
| **Connection cap** | `MAX_CONNECTIONS` simultaneous connections max — excess are refused at the socket level before any code runs |
| **Slow-loris defence** | Clients must send request headers within `HEADERS_TIMEOUT_MS` or the connection is dropped |
| **Idle connection cleanup** | Keep-alive connections are closed after `KEEP_ALIVE_TIMEOUT_MS` to free server resources |
| **Payload size limit** | Request bodies over 1 MB are rejected with 413 |
| **Container hardening** | Runs as non-root `node` user, read-only filesystem, all Linux capabilities dropped |

`BREVO_API_KEY` never leaves the server — Lovable only knows `PROXY_SECRET`, which only grants access to this proxy, not to Brevo directly.

## Error responses

| Status | Meaning |
|---|---|
| `401` | Missing or wrong `x-proxy-key` |
| `403` | IP is blacklisted |
| `404` | Unknown route |
| `405` | Wrong HTTP method |
| `413` | Request body over 1 MB |
| `429` | Rate limit exceeded |
| `500` | `BREVO_API_KEY` not configured |
| `502` | Could not reach Brevo |
| `504` | Brevo did not respond within 10 seconds |

## Local development

```bash
# 1. Install dependencies
npm install

# 2. Create your .env file
cp .env.example .env
# Edit .env and fill in BREVO_API_KEY and PROXY_SECRET

# 3. Start the server
npm start
# or with auto-reload:
npm run dev

# 4. Run tests
npm test
```

Test the health endpoint:
```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

Test auth rejection:
```bash
curl -X POST http://localhost:3000/send-transactional-email \
  -H "Content-Type: application/json" -d '{}'
# 401 {"error":"Unauthorized"}
```

Test the full proxy (replace values accordingly):
```bash
curl -X POST http://localhost:3000/send-transactional-email \
  -H "Content-Type: application/json" \
  -H "x-proxy-key: your-proxy-secret" \
  -d '{
    "sender": { "email": "hello@example.com", "name": "Example" },
    "to": [{ "email": "recipient@example.com" }],
    "subject": "Test",
    "htmlContent": "<p>Hello!</p>"
  }'
```

## Deploying on Coolify

Coolify builds directly from the repository and injects environment variables through its UI — no `.env` file needed on the server.

### 1. Create the service

1. In Coolify, go to your project → **Add Resource → Public/Private Repository**.
2. Point it at this repo.
3. Set **Build Pack** to **Dockerfile**.

### 2. Set environment variables

In the service's **Environment Variables** tab add at minimum:

| Key | Value |
|---|---|
| `BREVO_API_KEY` | your real Brevo API key |
| `PROXY_SECRET` | a long random string |

Mark both as **Secret** so they are not shown in logs. Add any optional variables from the table above to tune rate limiting and connection behaviour.

### 3. Configure the domain & port

- Set the exposed port to **3000** (or whatever `PORT` is set to).
- Assign a domain — Coolify provisions the SSL certificate automatically.

### 4. Deploy

Click **Deploy**. Coolify builds the image and starts the container. The `HEALTHCHECK` in the Dockerfile polls `/health` every 30 seconds — the service shows **Healthy** once it responds.

### 5. Verify

```bash
curl https://your-coolify-domain.com/health
# {"status":"ok"}

curl -X POST https://your-coolify-domain.com/send-transactional-email \
  -H "Content-Type: application/json" -d '{}'
# 401 {"error":"Unauthorized"}
```

## Lovable edge function setup

In your Lovable edge function, send requests to this proxy instead of directly to Brevo:

```ts
const res = await fetch('https://your-proxy-domain.com/send-transactional-email', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-proxy-key': Deno.env.get('PROXY_SECRET'),
  },
  body: JSON.stringify({
    sender: { email: 'hello@yourdomain.com', name: 'Your App' },
    to: [{ email: userEmail }],
    subject: 'Welcome',
    htmlContent: '<p>Hello!</p>',
  }),
});
```

Store `PROXY_SECRET` as a Lovable secret. The email payload is forwarded to Brevo unchanged — the proxy only adds the `api-key` header.

## Docker (local / self-managed)

```bash
cp .env.example .env
# Edit .env with real values

docker compose up -d
docker compose logs -f
docker compose down
```
