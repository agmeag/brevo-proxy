# brevo-proxy

Thin HTTP proxy that receives requests from a Lovable frontend and forwards them to [Brevo's transactional email API](https://developers.brevo.com/reference/sendtransacemail). The real Brevo API key never leaves the server.

## How it works

```
Lovable edge function
  POST /v3/smtp/email
  x-proxy-key: <PROXY_SECRET>
        │
        ▼
  brevo-proxy (this server)
  validates x-proxy-key, injects api-key header
        │
        ▼
  api.brevo.com/v3/smtp/email
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `BREVO_API_KEY` | ✅ | Your Brevo API key — never exposed to the frontend |
| `PROXY_SECRET` | ✅ | Shared secret Lovable sends as `x-proxy-key` header |
| `PORT` | — | Port the server listens on (default: `3000`) |

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
```

Test the health endpoint:
```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

Test the proxy (replace values accordingly):
```bash
curl -X POST http://localhost:3000/v3/smtp/email \
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
3. Set **Build Pack** to **Dockerfile** (Coolify will pick up the `Dockerfile` automatically).

### 2. Set environment variables

In the service's **Environment Variables** tab add:

| Key | Value |
|---|---|
| `BREVO_API_KEY` | your real Brevo API key |
| `PROXY_SECRET` | a long random string |
| `PORT` | `3000` (or leave unset to use the default) |

Mark both `BREVO_API_KEY` and `PROXY_SECRET` as **Secret** so they are not shown in logs.

### 3. Configure the domain & port

- Set the exposed port to **3000** (or whatever `PORT` is set to).
- Assign a domain — Coolify provisions the SSL certificate automatically.

### 4. Deploy

Click **Deploy**. Coolify builds the image, starts the container, and begins polling `/health` every 30 seconds (configured in the `Dockerfile` `HEALTHCHECK`). The service shows **Healthy** once the endpoint responds.

### 5. Verify

```bash
# Health check
curl https://your-coolify-domain.com/health
# {"status":"ok"}

# Auth rejection
curl -X POST https://your-coolify-domain.com/v3/smtp/email \
  -H "Content-Type: application/json" -d '{}'
# 401 {"message":"Unauthorized"}
```

## Docker (local / self-managed)

```bash
# 1. Create your .env file
cp .env.example .env
# Edit .env with real values

# 2. Build and start
docker compose up -d

# 3. Check logs
docker compose logs -f

# 4. Stop
docker compose down
```

The container runs as the non-root `node` user with a read-only filesystem and all Linux capabilities dropped.

## Lovable edge function setup

In your Lovable edge function, send requests to this proxy instead of directly to Brevo:

```ts
const res = await fetch('https://your-server.com/v3/smtp/email', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-proxy-key': Deno.env.get('PROXY_SECRET'),
  },
  body: JSON.stringify(emailPayload),
});
```

Store `PROXY_SECRET` as a Lovable secret — it only grants access to this proxy, not to Brevo directly.

## Security notes

- `BREVO_API_KEY` never leaves the server — the frontend only knows `PROXY_SECRET`.
- Rotate `PROXY_SECRET` any time you suspect it has been leaked (Lovable secrets + server `.env`).
- The container drops all Linux capabilities and runs read-only to minimise attack surface.
