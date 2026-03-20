# Trakt Proxy

Next.js API proxy for Trakt OAuth, token refresh, sync, and enrichment. The service uses Firebase Admin to read and write Trakt connection state under `users/{uid}` in Firestore.

## Required Environment Variables

- `TRAKT_CLIENT_ID`
- `TRAKT_CLIENT_SECRET`
- `TRAKT_REDIRECT_URI`
- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`
- `NEXT_PUBLIC_APP_URL`
- `TMDB_API_KEY`
- `TRAKT_INTERNAL_DELETE_AUTH`: shared bearer token required by the internal account deletion route. This must match the Firebase Functions secret used by `show-seek`.

## Internal Account Deletion Route

`POST /api/trakt/delete-user`

Headers:

- `Authorization: Bearer <TRAKT_INTERNAL_DELETE_AUTH>`
- `Content-Type: application/json`

Request body:

```json
{
  "userId": "firebase_user_id"
}
```

Success response:

```json
{
  "success": true,
  "userId": "firebase_user_id"
}
```

Behavior:

- Clears Trakt-owned connection fields from `users/{uid}`:
  - `traktAccessToken`
  - `traktRefreshToken`
  - `traktTokenExpiresAt`
  - `traktConnectedAt`
  - `traktSyncStatus`
  - sets `traktConnected` to `false`
- Returns success if the user document is already missing.
- Does not delete shared Firestore data such as `lists`, `ratings`, or `episode_tracking`. Full account deletion remains the responsibility of the main `show-seek` backend.

Failure responses:

- `400` when `userId` is missing or invalid
- `401` when the bearer token is missing or invalid
- `500` when runtime configuration is missing or an unexpected Firestore error occurs

## Related Docs

- OAuth configuration and recovery guidance: [docs/trakt-oauth-runbook.md](/Users/edufocal/Desktop/projects/trakt-proxy/docs/trakt-oauth-runbook.md)
