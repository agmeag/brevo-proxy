# Lovable Integration Guide

This guide tells you exactly how to connect a Lovable project to the brevo-proxy.

## What you need first

- The proxy deployed and running
- The proxy URL (e.g. `https://proxy.yourdomain.com`)
- The `PROXY_SECRET` value you set on the server

## Step 1 — Add secrets in Lovable

In your Lovable project go to **Settings → Secrets** and add:

| Secret name | Value |
|---|---|
| `BREVO_PROXY_URL` | `https://proxy.yourdomain.com` |
| `BREVO_PROXY_SECRET` | the same value as `PROXY_SECRET` on the server |

## Step 2 — Create a Supabase edge function

Create a new edge function in your Lovable project. The function must:

1. Read `BREVO_PROXY_URL` and `BREVO_PROXY_SECRET` from environment secrets
2. Accept a POST request with a JSON body containing the Brevo email payload
3. Forward that body unchanged to `{BREVO_PROXY_URL}/send-transactional-email`
4. Set the header `x-proxy-key` to the value of `BREVO_PROXY_SECRET`
5. Set the header `Content-Type` to `application/json`
6. Return the proxy response as-is back to the caller

## Step 3 — Call the edge function from your frontend

Wherever you need to send an email in your Lovable app, call the edge function with a POST request and a JSON body following the [Brevo transactional email format](https://developers.brevo.com/reference/sendtransacemail):

```json
{
  "sender": { "email": "hello@yourdomain.com", "name": "Your App" },
  "to": [{ "email": "recipient@example.com" }],
  "subject": "Your subject here",
  "htmlContent": "<p>Your email body here</p>"
}
```

## How the full flow works

```
Lovable frontend
  calls edge function with email payload
        │
        ▼
Supabase edge function
  adds x-proxy-key header
  POSTs to /send-transactional-email
        │
        ▼
brevo-proxy
  validates x-proxy-key
  checks rate limit and blacklist
  forwards body to Brevo with api-key header
        │
        ▼
Brevo API
  sends the email
  returns { messageId }
        │
        ▼ (passed back through)
Lovable frontend receives { messageId }
```

## Verifying the connection

Before wiring it into the UI, verify the proxy is reachable and auth works by running these curl commands from your terminal:

```bash
# 1. Health check — should return {"status":"ok"}
curl https://proxy.yourdomain.com/health

# 2. Auth rejection — should return 401
curl -X POST https://proxy.yourdomain.com/send-transactional-email \
  -H "Content-Type: application/json" -d '{}'

# 3. Auth acceptance — should return anything other than 401
curl -X POST https://proxy.yourdomain.com/send-transactional-email \
  -H "Content-Type: application/json" \
  -H "x-proxy-key: your-proxy-secret" \
  -d '{"test": true}'
```

If step 1 passes and step 3 does not return 401, the proxy is ready and Lovable can connect.
