import {
  TraktWatchedMovie,
  TraktWatchedShow,
  TraktRating,
  TraktList,
  TraktListItem,
  TraktWatchlistItem,
  TraktFavorite,
} from "@/utils/types/trakt";

const TRAKT_API_BASE = "https://api.trakt.tv";
const TRAKT_API_VERSION = "2";
const TRAKT_OAUTH_TIMEOUT_MS = 12000;
const TRAKT_OAUTH_USER_AGENT = "ShowSeek-TraktProxy/1.0";

interface TraktRequestOptions {
  accessToken: string;
  endpoint: string;
  method?: "GET" | "POST";
  body?: any;
}

export type TraktOAuthFailureReason =
  | "upstream_blocked"
  | "invalid_oauth"
  | "upstream_unavailable";

interface TraktTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  created_at: number;
}

interface TraktOAuthErrorDetails {
  reason: TraktOAuthFailureReason;
  status?: number;
  cfRay?: string;
  snippet?: string;
  upstreamError?: string;
  cause?: unknown;
}

export class TraktOAuthError extends Error {
  reason: TraktOAuthFailureReason;
  status?: number;
  cfRay?: string;
  snippet?: string;
  upstreamError?: string;
  cause?: unknown;

  constructor(message: string, details: TraktOAuthErrorDetails) {
    super(message);
    this.name = "TraktOAuthError";
    this.reason = details.reason;
    this.status = details.status;
    this.cfRay = details.cfRay;
    this.snippet = details.snippet;
    this.upstreamError = details.upstreamError;
    this.cause = details.cause;
  }
}

function getOAuthConfig() {
  const clientId = process.env.TRAKT_CLIENT_ID;
  const clientSecret = process.env.TRAKT_CLIENT_SECRET;
  const redirectUri = process.env.TRAKT_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new TraktOAuthError("Missing Trakt OAuth configuration", {
      reason: "invalid_oauth",
    });
  }

  return { clientId, clientSecret, redirectUri };
}

function getOAuthProxyBaseUrl(): string | undefined {
  const proxyBaseUrl = process.env.TRAKT_OAUTH_PROXY_BASE_URL?.trim();
  return proxyBaseUrl || undefined;
}

function resolveOAuthEndpoint(
  operation: "token_exchange" | "token_refresh",
): string {
  const proxyBaseUrl = getOAuthProxyBaseUrl();
  if (!proxyBaseUrl) {
    return `${TRAKT_API_BASE}/oauth/token`;
  }

  const path =
    operation === "token_exchange"
      ? "/oauth/token/exchange"
      : "/oauth/token/refresh";

  try {
    return new URL(path, proxyBaseUrl).toString();
  } catch {
    throw new TraktOAuthError("Invalid TRAKT_OAUTH_PROXY_BASE_URL value", {
      reason: "upstream_unavailable",
    });
  }
}

function sanitizeSnippet(raw: string): string | undefined {
  const compact = raw.replace(/\s+/g, " ").trim();
  if (!compact) {
    return undefined;
  }

  return compact.slice(0, 240);
}

function isCloudflareBlockedResponse(
  status: number,
  contentType: string,
  rawBody: string,
  cfRay?: string,
): boolean {
  const lowerBody = rawBody.toLowerCase();
  const isHtmlResponse = contentType.includes("text/html");

  if (status === 403 && (cfRay || isHtmlResponse)) {
    return true;
  }

  return (
    lowerBody.includes("cloudflare") ||
    lowerBody.includes("attention required") ||
    lowerBody.includes("you have been blocked") ||
    lowerBody.includes("cf-ray")
  );
}

function parseTokenResponse(rawBody: string): TraktTokenResponse | undefined {
  if (!rawBody) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(rawBody) as Partial<TraktTokenResponse>;

    if (
      typeof parsed.access_token !== "string" ||
      typeof parsed.refresh_token !== "string" ||
      typeof parsed.expires_in !== "number" ||
      typeof parsed.created_at !== "number"
    ) {
      return undefined;
    }

    return parsed as TraktTokenResponse;
  } catch {
    return undefined;
  }
}

function parseErrorCode(rawBody: string): string | undefined {
  if (!rawBody) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(rawBody) as { error?: unknown };
    if (typeof parsed.error === "string") {
      return parsed.error;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function getOAuthRequestHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": TRAKT_OAUTH_USER_AGENT,
    "trakt-api-version": TRAKT_API_VERSION,
  };

  if (process.env.TRAKT_CLIENT_ID) {
    headers["trakt-api-key"] = process.env.TRAKT_CLIENT_ID;
  }

  return headers;
}

async function requestOAuthToken(
  body: Record<string, string>,
  operation: "token_exchange" | "token_refresh",
): Promise<TraktTokenResponse> {
  let response: Response;

  try {
    response = await fetch(resolveOAuthEndpoint(operation), {
      method: "POST",
      headers: getOAuthRequestHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TRAKT_OAUTH_TIMEOUT_MS),
    });
  } catch (error) {
    const message =
      operation === "token_exchange"
        ? "Token exchange request timed out or failed to reach Trakt"
        : "Token refresh request timed out or failed to reach Trakt";

    throw new TraktOAuthError(message, {
      reason: "upstream_unavailable",
      cause: error,
    });
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const cfRay = response.headers.get("cf-ray") ?? undefined;
  const rawBody = await response.text();
  const snippet = sanitizeSnippet(rawBody);
  const upstreamError = parseErrorCode(rawBody);
  const parsedTokenResponse = parseTokenResponse(rawBody);

  if (response.ok) {
    if (parsedTokenResponse) {
      return parsedTokenResponse;
    }

    throw new TraktOAuthError("Trakt OAuth returned an unexpected response", {
      reason: "upstream_unavailable",
      status: response.status,
      cfRay,
      snippet,
      upstreamError,
    });
  }

  if (
    isCloudflareBlockedResponse(response.status, contentType, rawBody, cfRay)
  ) {
    throw new TraktOAuthError("Trakt OAuth request was blocked upstream", {
      reason: "upstream_blocked",
      status: response.status,
      cfRay,
      snippet,
      upstreamError,
    });
  }

  if (upstreamError || response.status < 500) {
    throw new TraktOAuthError("Trakt OAuth rejected the request", {
      reason: "invalid_oauth",
      status: response.status,
      cfRay,
      snippet,
      upstreamError,
    });
  }

  throw new TraktOAuthError("Trakt OAuth is temporarily unavailable", {
    reason: "upstream_unavailable",
    status: response.status,
    cfRay,
    snippet,
    upstreamError,
  });
}

/**
 * Make authenticated request to Trakt API
 */
export async function traktRequest<T>({
  accessToken,
  endpoint,
  method = "GET",
  body,
}: TraktRequestOptions): Promise<T> {
  const url = `${TRAKT_API_BASE}${endpoint}`;

  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "trakt-api-version": TRAKT_API_VERSION,
      "trakt-api-key": process.env.TRAKT_CLIENT_ID!,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Trakt API error: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }

  return response.json();
}

/**
 * Get all watched movies
 */
export async function getWatchedMovies(
  accessToken: string,
): Promise<TraktWatchedMovie[]> {
  return traktRequest({
    accessToken,
    endpoint: "/sync/watched/movies",
  });
}

/**
 * Get all watched TV shows with episode details
 */
export async function getWatchedShows(
  accessToken: string,
): Promise<TraktWatchedShow[]> {
  return traktRequest({
    accessToken,
    endpoint: "/sync/watched/shows?extended=full",
  });
}

/**
 * Get all ratings (movies and shows)
 */
export async function getRatings(accessToken: string): Promise<TraktRating[]> {
  return traktRequest({
    accessToken,
    endpoint: "/sync/ratings",
  });
}

/**
 * Get user's custom lists
 */
export async function getUserLists(
  accessToken: string,
  username: string,
): Promise<TraktList[]> {
  return traktRequest({
    accessToken,
    endpoint: `/users/${username}/lists`,
  });
}

/**
 * Get items in a specific list
 */
export async function getListItems(
  accessToken: string,
  username: string,
  listId: string,
): Promise<TraktListItem[]> {
  return traktRequest({
    accessToken,
    endpoint: `/users/${username}/lists/${listId}/items`,
  });
}

/**
 * Get user's watchlist
 */
export async function getWatchlist(
  accessToken: string,
): Promise<TraktWatchlistItem[]> {
  return traktRequest({
    accessToken,
    endpoint: "/sync/watchlist",
  });
}

/**
 * Get user's favorites
 */
export async function getFavorites(
  accessToken: string,
): Promise<TraktFavorite[]> {
  return traktRequest({
    accessToken,
    endpoint: "/sync/favorites",
  });
}

/**
 * Get user profile to retrieve username
 */
export async function getUserProfile(accessToken: string): Promise<{
  username: string;
  private: boolean;
  name: string;
  vip: boolean;
  vip_ep: boolean;
  ids: { slug: string };
}> {
  // The /users/settings endpoint returns { user: {...}, account: {...}, connections: {...} }
  const response = await traktRequest<{
    user: {
      username: string;
      private: boolean;
      name: string;
      vip: boolean;
      vip_ep: boolean;
      ids: { slug: string };
    };
  }>({
    accessToken,
    endpoint: "/users/settings",
  });

  return response.user;
}

/**
 * Exchange OAuth authorization code for access and refresh tokens
 */
export async function exchangeAuthorizationCode(
  code: string,
): Promise<TraktTokenResponse> {
  const proxyBaseUrl = getOAuthProxyBaseUrl();

  if (proxyBaseUrl) {
    return requestOAuthToken(
      {
        code,
      },
      "token_exchange",
    );
  }

  const { clientId, clientSecret, redirectUri } = getOAuthConfig();

  return requestOAuthToken(
    {
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    },
    "token_exchange",
  );
}

/**
 * Refresh access token using refresh token
 */
export async function refreshAccessToken(
  refreshToken: string,
): Promise<TraktTokenResponse> {
  const proxyBaseUrl = getOAuthProxyBaseUrl();

  if (proxyBaseUrl) {
    return requestOAuthToken(
      {
        refresh_token: refreshToken,
      },
      "token_refresh",
    );
  }

  const { clientId, clientSecret, redirectUri } = getOAuthConfig();

  return requestOAuthToken(
    {
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "refresh_token",
    },
    "token_refresh",
  );
}
