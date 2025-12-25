/**
 * TMDB Season-Level Caching
 *
 * Provides a global cache for TMDB season data to reduce API calls
 * and share data across all users during episode enrichment.
 *
 * Cache location: tmdb_cache/shows/{tmdbShowId}/seasons/{seasonNumber}
 */

import { Timestamp } from "firebase-admin/firestore";
import { db } from "@/lib/firebase-admin";

const TMDB_API_BASE = "https://api.themoviedb.org/3";

// TTL constants
const DEFAULT_TTL_DAYS = 30;
const ONGOING_TTL_DAYS = 7;
const RECENT_AIR_DATE_DAYS = 14; // Consider season "ongoing" if latest episode aired within this window

// ============================================================================
// Types
// ============================================================================

export interface SeasonCacheEpisode {
  episodeId: number;
  episodeName: string;
  episodeAirDate: string | null;
}

export interface SeasonCache {
  episodes: Record<string, SeasonCacheEpisode>;
  lastUpdated: Timestamp;
  status: "complete" | "populating";
}

interface TMDBSeasonResponse {
  id: number;
  season_number: number;
  episodes: Array<{
    id: number;
    name: string;
    episode_number: number;
    air_date: string | null;
  }>;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if the cache is stale based on TTL rules
 */
function isCacheStale(cache: SeasonCache): boolean {
  const now = Date.now();
  const lastUpdatedMs = cache.lastUpdated.toMillis();

  // Check if any episode appears to be from an ongoing season
  const isOngoingSeason = isSeasonOngoing(cache.episodes);

  const ttlDays = isOngoingSeason ? ONGOING_TTL_DAYS : DEFAULT_TTL_DAYS;
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;

  return now - lastUpdatedMs > ttlMs;
}

/**
 * Determine if a season appears to be ongoing
 * A season is considered ongoing if:
 * - The latest episode has no air date, OR
 * - The latest episode aired within the last 14 days
 */
function isSeasonOngoing(
  episodes: Record<string, SeasonCacheEpisode>,
): boolean {
  const episodeNumbers = Object.keys(episodes)
    .map(Number)
    .sort((a, b) => b - a);

  if (episodeNumbers.length === 0) return false;

  const latestEpisode = episodes[episodeNumbers[0].toString()];

  // No air date means it might not have aired yet
  if (!latestEpisode.episodeAirDate) {
    return true;
  }

  // Check if the latest episode aired recently
  const airDate = new Date(latestEpisode.episodeAirDate);
  const daysSinceAired =
    (Date.now() - airDate.getTime()) / (1000 * 60 * 60 * 24);

  return daysSinceAired < RECENT_AIR_DATE_DAYS;
}

/**
 * Fetch season data from TMDB API
 */
async function fetchSeasonFromTMDB(
  tmdbShowId: number,
  seasonNumber: number,
): Promise<TMDBSeasonResponse | null> {
  try {
    const response = await fetch(
      `${TMDB_API_BASE}/tv/${tmdbShowId}/season/${seasonNumber}?api_key=${process.env.TMDB_API_KEY}`,
    );

    if (!response.ok) {
      console.error(
        `Failed to fetch season ${seasonNumber} for show ${tmdbShowId}: ${response.status}`,
      );
      return null;
    }

    return response.json();
  } catch (error) {
    console.error(
      `Error fetching season ${seasonNumber} for show ${tmdbShowId}:`,
      error,
    );
    return null;
  }
}

/**
 * Transform TMDB season response to our cache format
 */
function transformSeasonData(
  tmdbSeason: TMDBSeasonResponse,
): Record<string, SeasonCacheEpisode> {
  const episodes: Record<string, SeasonCacheEpisode> = {};

  for (const ep of tmdbSeason.episodes) {
    episodes[ep.episode_number.toString()] = {
      episodeId: ep.id,
      episodeName: ep.name,
      episodeAirDate: ep.air_date ?? null,
    };
  }

  return episodes;
}

// ============================================================================
// Main Cache Function
// ============================================================================

/**
 * Get season data from Firestore cache or fetch from TMDB
 *
 * This function implements:
 * - Cache lookup with freshness check
 * - Concurrency safety (skips if another request is populating)
 * - Automatic TTL-based refresh
 *
 * @param tmdbShowId - TMDB show ID
 * @param seasonNumber - Season number
 * @returns Season cache data, or null if unavailable/being populated
 */
export async function getSeasonFromCacheOrTMDB(
  tmdbShowId: number,
  seasonNumber: number,
): Promise<SeasonCache | null> {
  const cacheRef = db
    .collection("tmdb_cache")
    .doc("shows")
    .collection(tmdbShowId.toString())
    .doc("seasons")
    .collection(seasonNumber.toString())
    .doc("data");

  // Alternative structure using subcollections properly:
  const seasonRef = db.doc(
    `tmdb_cache/shows/${tmdbShowId}/seasons/${seasonNumber}`,
  );

  try {
    // Step 1: Check cache
    const cacheDoc = await seasonRef.get();

    if (cacheDoc.exists) {
      const cacheData = cacheDoc.data() as SeasonCache;

      // If another request is populating, skip to avoid duplicate TMDB calls
      if (cacheData.status === "populating") {
        console.log(
          `Season ${seasonNumber} for show ${tmdbShowId} is being populated, skipping`,
        );
        return null;
      }

      // If cache is fresh, return it
      if (cacheData.status === "complete" && !isCacheStale(cacheData)) {
        console.log(
          `Using cached season data for show ${tmdbShowId} season ${seasonNumber}`,
        );
        return cacheData;
      }

      console.log(
        `Cache stale for show ${tmdbShowId} season ${seasonNumber}, refreshing`,
      );
    }

    // Step 2: Mark as populating (optimistic lock)
    await seasonRef.set(
      {
        status: "populating",
        lastUpdated: Timestamp.now(),
      },
      { merge: true },
    );

    // Step 3: Fetch from TMDB
    console.log(
      `Fetching season ${seasonNumber} for show ${tmdbShowId} from TMDB`,
    );
    const tmdbSeason = await fetchSeasonFromTMDB(tmdbShowId, seasonNumber);

    if (!tmdbSeason) {
      // Clean up the populating status on failure
      await seasonRef.delete();
      return null;
    }

    // Step 4: Transform and store
    const episodes = transformSeasonData(tmdbSeason);
    const cacheData: SeasonCache = {
      episodes,
      lastUpdated: Timestamp.now(),
      status: "complete",
    };

    await seasonRef.set(cacheData);

    console.log(
      `Cached season ${seasonNumber} for show ${tmdbShowId} with ${Object.keys(episodes).length} episodes`,
    );

    return cacheData;
  } catch (error) {
    console.error(
      `Error in getSeasonFromCacheOrTMDB for show ${tmdbShowId} season ${seasonNumber}:`,
      error,
    );
    return null;
  }
}
