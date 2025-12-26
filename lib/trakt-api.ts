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

interface TraktRequestOptions {
  accessToken: string;
  endpoint: string;
  method?: "GET" | "POST";
  body?: any;
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
 * Refresh access token using refresh token
 */
export async function refreshAccessToken(refreshToken: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
  created_at: number;
}> {
  const response = await fetch(`${TRAKT_API_BASE}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      refresh_token: refreshToken,
      client_id: process.env.TRAKT_CLIENT_ID,
      client_secret: process.env.TRAKT_CLIENT_SECRET,
      redirect_uri: process.env.TRAKT_REDIRECT_URI,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    throw new Error("Failed to refresh Trakt access token");
  }

  return response.json();
}
