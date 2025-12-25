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
const ERROR_TTL_MINUTES = 5; // Wait before retrying after a fetch error

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
  status: "complete" | "populating" | "error";
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
 * - Transaction-safe concurrency protection (prevents duplicate TMDB fetches)
 * - Automatic TTL-based refresh
 *
 * CONCURRENCY PROTECTION:
 * Uses a Firestore transaction to atomically check and set the "populating" status.
 * This prevents the race condition where multiple concurrent requests could read
 * the document, all see it's not populating, and then all fetch from TMDB.
 * Only the request that successfully commits the transaction may proceed with
 * the TMDB fetch - all others receive null and skip fetching.
 *
 * @param tmdbShowId - TMDB show ID
 * @param seasonNumber - Season number
 * @returns Season cache data, or null if unavailable/being populated
 */
export async function getSeasonFromCacheOrTMDB(
  tmdbShowId: number,
  seasonNumber: number,
): Promise<SeasonCache | null> {
  const seasonRef = db.doc(
    `tmdb_cache/shows/${tmdbShowId}/seasons/${seasonNumber}`,
  );

  try {
    // ========================================================================
    // STEP 1: Transaction-safe lock acquisition
    // ========================================================================
    // Use a transaction to atomically:
    // 1. Read the current document state
    // 2. Determine if we should fetch from TMDB
    // 3. Set status = "populating" if we're the one who should fetch
    //
    // The transaction guarantees that only ONE request can successfully
    // commit the "populating" status - all concurrent requests will either:
    // - See "populating" and abort
    // - Have their transaction conflict and retry (seeing "populating")
    // ========================================================================

    const transactionResult = await db.runTransaction(async (transaction) => {
      const cacheDoc = await transaction.get(seasonRef);

      if (cacheDoc.exists) {
        const cacheData = cacheDoc.data() as SeasonCache;

        // CASE 1: Another request is already populating - abort immediately
        // This prevents duplicate TMDB fetches
        if (cacheData.status === "populating") {
          console.log(
            `Season ${seasonNumber} for show ${tmdbShowId} is being populated, skipping`,
          );
          return { action: "skip" as const, data: null };
        }

        // CASE 2: Previous fetch errored - check if we should retry
        if (cacheData.status === "error") {
          const errorAgeMs = Date.now() - cacheData.lastUpdated.toMillis();
          const errorTtlMs = ERROR_TTL_MINUTES * 60 * 1000;

          if (errorAgeMs < errorTtlMs) {
            // Error TTL not expired yet - wait before retrying
            console.log(
              `Season ${seasonNumber} for show ${tmdbShowId} recently errored, skipping for ${Math.ceil((errorTtlMs - errorAgeMs) / 1000)}s`,
            );
            return { action: "skip" as const, data: null };
          }
          // Error TTL expired - allow retry, fall through to acquire lock
          console.log(
            `Error TTL expired for show ${tmdbShowId} season ${seasonNumber}, retrying`,
          );
        }

        // CASE 3: Cache is fresh and complete - return it directly
        if (cacheData.status === "complete" && !isCacheStale(cacheData)) {
          console.log(
            `Using cached season data for show ${tmdbShowId} season ${seasonNumber}`,
          );
          return { action: "return_cache" as const, data: cacheData };
        }

        // Cache is stale - need to refresh
        console.log(
          `Cache stale for show ${tmdbShowId} season ${seasonNumber}, refreshing`,
        );
      }

      // ======================================================================
      // ACQUIRE LOCK: Set status = "populating" atomically within transaction
      // ======================================================================
      // This is the critical section - only ONE request can successfully
      // commit this transaction. All other concurrent requests will either:
      // - See our "populating" status and skip (first check above)
      // - Have their transaction fail due to the conflict and retry
      // ======================================================================
      transaction.set(
        seasonRef,
        {
          status: "populating",
          lastUpdated: Timestamp.now(),
        },
        { merge: true },
      );

      return { action: "fetch" as const, data: null };
    });

    // Handle transaction results
    if (transactionResult.action === "skip") {
      return null;
    }

    if (transactionResult.action === "return_cache") {
      return transactionResult.data;
    }

    // ========================================================================
    // STEP 2: Fetch from TMDB (only if we acquired the lock)
    // ========================================================================
    // At this point, we successfully committed the transaction with
    // status = "populating", so we're the only request that should fetch.
    // ========================================================================

    console.log(
      `Fetching season ${seasonNumber} for show ${tmdbShowId} from TMDB`,
    );
    const tmdbSeason = await fetchSeasonFromTMDB(tmdbShowId, seasonNumber);

    if (!tmdbSeason) {
      // TMDB fetch failed - set error status to prevent concurrent retry storms.
      // IMPORTANT: Use merge: true to preserve any previously cached episodes.
      // If we used merge: false or set episodes: {}, we would destroy valid
      // cached data from a previous successful fetch. The ERROR_TTL ensures
      // we can still retry and refresh the cache after the backoff period.
      await seasonRef.set(
        {
          status: "error",
          lastUpdated: Timestamp.now(),
        },
        { merge: true },
      );
      console.log(
        `Marked season ${seasonNumber} for show ${tmdbShowId} as error, will retry after ${ERROR_TTL_MINUTES} minutes`,
      );
      return null;
    }

    // ========================================================================
    // STEP 3: Transform and store the fetched data
    // ========================================================================

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
