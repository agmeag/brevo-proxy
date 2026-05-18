# brevo-proxy

Thin HTTP proxy that receives requests from a Lovable frontend and forwards them to Brevo's transactional email API (`/v3/smtp/email`). The Brevo API key is kept server-side and never exposed to the frontend.

## Setup

```bash
npm install
```

## Environment variables

- `BREVO_API_KEY` (required): Brevo API key used by the proxy.
- `PORT` (optional, default `3000`): local server port.
- `CORS_ALLOW_ORIGIN` (optional, default `*`): allowed origin for browser requests.
- `BREVO_API_BASE_URL` (optional): override target URL for testing (defaults to `https://api.brevo.com/v3/smtp/email`).

## Run

```bash
npm start
```

## Endpoint

### `POST /send-transactional-email`

Accepts a JSON body compatible with Brevo's `sendTransacEmail` payload and forwards it to Brevo with the server-side `api-key` header.

Example:

```bash
curl -X POST http://localhost:3000/send-transactional-email \
  -H 'Content-Type: application/json' \
  -d '{
    "sender": {"email": "noreply@example.com"},
    "to": [{"email": "user@example.com"}],
    "subject": "Welcome",
    "htmlContent": "<p>Hello!</p>"
  }'
```
