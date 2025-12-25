/**
 * TMDB Season-Level Caching
 *
 * Provides a global cache for TMDB season data to reduce API calls
 * and share data across all users during episode enrichment.
 *
 * Cache structure:
 * - TV Seasons: tmdb_cache/tv/seasons/{showId}_{seasonNumber}
 * - (Future) Movies: tmdb_cache/movie/details/{movieId}
 */

import { Timestamp } from "firebase-admin/firestore";
import { db } from "@/lib/firebase-admin";
import { TMDB_API_BASE } from "@/utils/constants";

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
 * Determine if a season appears to be ongoing.
 *
 * A season is considered "ongoing" if it may receive new episodes or data updates soon.
 * This affects cache TTL - ongoing seasons refresh more frequently (every 7 days)
 * while completed seasons use a longer TTL (30 days).
 *
 * DETECTION LOGIC:
 * 1. PREFER AIR DATES: Find the episode with the most recent (latest) air_date.
 *    This is more reliable than episode numbers because episodes may air out of order,
 *    be added retroactively, or have numbering gaps.
 *
 * 2. FALLBACK TO EPISODE NUMBER: If NO episodes have air dates, use the highest
 *    episode number as a proxy for "latest". In this case, we assume the season
 *    is ongoing since missing air dates often indicate upcoming/unaired episodes.
 *
 * A season IS ongoing if:
 * - Any episode has no air date (indicates upcoming/unaired episodes), OR
 * - The most recently aired episode aired within RECENT_AIR_DATE_DAYS (14 days)
 *
 * @param episodes - Record of episode number -> episode data
 * @returns true if the season appears to be ongoing, false if it's complete
 */
function isSeasonOngoing(
  episodes: Record<string, SeasonCacheEpisode>,
): boolean {
  const episodeList = Object.values(episodes);

  // No episodes means we can't determine status - treat as ongoing (conservative)
  // This ensures we use the shorter ONGOING_TTL_DAYS for more frequent refreshes
  if (episodeList.length === 0) return true;

  // Check if ANY episode is missing an air date (indicates upcoming/unaired episodes)
  // This catches cases where future episodes are announced but not yet aired
  const hasEpisodeWithoutAirDate = episodeList.some((ep) => !ep.episodeAirDate);
  if (hasEpisodeWithoutAirDate) {
    return true;
  }

  // All episodes have air dates - find the one with the LATEST (most recent) air date
  // This is more reliable than episode numbers since episodes can air out of order
  let latestAirDate: Date | null = null;

  for (const episode of episodeList) {
    // We already checked all have air dates above, but TypeScript needs the guard
    if (!episode.episodeAirDate) continue;

    const airDate = new Date(episode.episodeAirDate);

    // Track the most recent air date
    if (!latestAirDate || airDate > latestAirDate) {
      latestAirDate = airDate;
    }
  }

  // This shouldn't happen given the check above, but handle gracefully
  if (!latestAirDate) {
    return true;
  }

  // Check if the most recently aired episode is within the "recent" window
  const daysSinceLatestAired =
    (Date.now() - latestAirDate.getTime()) / (1000 * 60 * 60 * 24);

  return daysSinceLatestAired < RECENT_AIR_DATE_DAYS;
}

/**
 * Fetch season data from TMDB API
 */
async function fetchSeasonFromTMDB(
  tmdbShowId: number,
  seasonNumber: number,
): Promise<TMDBSeasonResponse | null> {
  // Defensive check: ensure TMDB API key is configured
  if (!process.env.TMDB_API_KEY) {
    console.error(
      `Missing TMDB API key - cannot fetch season ${seasonNumber} for show ${tmdbShowId}`,
    );
    return null;
  }

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
    `tmdb_cache/tv/seasons/${tmdbShowId}_${seasonNumber}`,
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
    // OVERWRITE BEHAVIOR: We explicitly use merge: false (full overwrite) here.
    // This is safe and intentional because:
    // 1. We have fresh, complete season data from TMDB
    // 2. The new data should fully replace any stale/partial cached data
    // 3. All SeasonCache fields (episodes, lastUpdated, status) are provided
    // 4. There's no user-specific data in this cache - it's global TMDB data
    // ========================================================================

    const episodes = transformSeasonData(tmdbSeason);
    const cacheData: SeasonCache = {
      episodes,
      lastUpdated: Timestamp.now(),
      status: "complete",
    };

    await seasonRef.set(cacheData, { merge: false });

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
