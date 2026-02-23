# Trakt OAuth Runbook

## Stage 1: Production Config Checklist

Set the deployed environment variables exactly as follows:

- `NEXT_PUBLIC_APP_URL=https://trakt-proxy.vercel.app`
- `TRAKT_REDIRECT_URI=https://trakt-proxy.vercel.app/api/trakt/callback`

Verify Trakt application settings:

- Trakt OAuth callback URL must exactly match:
  - `https://trakt-proxy.vercel.app/api/trakt/callback`
- Scheme, host, and path must all match exactly.

Verify mobile authorization URL generation:

- `client_id` must match backend `TRAKT_CLIENT_ID`
- `redirect_uri` must match backend `TRAKT_REDIRECT_URI`
- `state` must carry user identity needed by callback

## Stage 1: Diagnostics to Collect

When callback fails and redirects to `/trakt/error`:

- capture `reason` query parameter
- if present, capture `ray` query parameter
- capture callback logs containing:
  - upstream status
  - `cfRay`
  - short response snippet

## Stage 2 Trigger

Move to Stage 2 when `reason=upstream_blocked` continues after Stage 1 config verification and request-hardening changes.

## Stage 2: Cloud Run Static Egress Design

Goal:

- move Trakt OAuth token exchange and token refresh off Vercel egress
- use a stable static outbound IP via Cloud NAT

High-level steps:

1. Deploy a minimal Cloud Run service with endpoints:
   - `POST /oauth/token/exchange`
   - `POST /oauth/token/refresh`
2. Configure Cloud Run outbound networking through Cloud NAT with a reserved static IP.
3. Route `app/api/trakt/callback` and refresh path in `lib/trakt-api.ts` through that service.
4. Provide Trakt support with:
   - static outbound IP
   - recent Cloudflare Ray IDs
   - timestamps of blocked requests

Operational notes:

- set `TRAKT_OAUTH_PROXY_BASE_URL` in proxy runtime to the Cloud Run base URL
- when `TRAKT_OAUTH_PROXY_BASE_URL` is set, this code routes:
  - exchange requests to `POST /oauth/token/exchange`
  - refresh requests to `POST /oauth/token/refresh`

- keep response payload from Cloud Run aligned with Trakt token fields:
  - `access_token`
  - `refresh_token`
  - `expires_in`
  - `created_at`
- preserve existing callback success redirect behavior.
