/**
 * TMDB API Integration for enriching Trakt data
 * Fetches missing metadata like posters, ratings, genres
 */

import { Timestamp } from "firebase-admin/firestore";
import { getSeasonFromCacheOrTMDB } from "@/lib/tmdb-cache";
import { TMDB_API_BASE } from "@/utils/constants";

interface TMDBMovie {
  id: number;
  title: string;
  poster_path: string | null;
  vote_average: number;
  release_date: string;
  genre_ids: number[];
}

interface TMDBShow {
  id: number;
  name: string;
  poster_path: string | null;
  vote_average: number;
  first_air_date: string;
  genre_ids: number[];
}

interface TMDBEpisode {
  id: number;
  name: string;
  still_path: string | null;
  air_date: string;
  episode_number: number;
  season_number: number;
}

/**
 * Fetch movie details from TMDB
 */
export async function fetchMovieDetails(
  tmdbId: number,
): Promise<TMDBMovie | null> {
  try {
    const response = await fetch(
      `${TMDB_API_BASE}/movie/${tmdbId}?api_key=${process.env.TMDB_API_KEY}`,
    );

    if (!response.ok) {
      console.error(`Failed to fetch movie ${tmdbId}: ${response.status}`);
      return null;
    }

    return response.json();
  } catch (error) {
    console.error(`Error fetching movie ${tmdbId}:`, error);
    return null;
  }
}

/**
 * Fetch TV show details from TMDB
 */
export async function fetchShowDetails(
  tmdbId: number,
): Promise<TMDBShow | null> {
  try {
    const response = await fetch(
      `${TMDB_API_BASE}/tv/${tmdbId}?api_key=${process.env.TMDB_API_KEY}`,
    );

    if (!response.ok) {
      console.error(`Failed to fetch show ${tmdbId}: ${response.status}`);
      return null;
    }

    return response.json();
  } catch (error) {
    console.error(`Error fetching show ${tmdbId}:`, error);
    return null;
  }
}

/**
 * Fetch episode details from TMDB
 */
export async function fetchEpisodeDetails(
  showId: number,
  season: number,
  episode: number,
): Promise<TMDBEpisode | null> {
  try {
    const response = await fetch(
      `${TMDB_API_BASE}/tv/${showId}/season/${season}/episode/${episode}?api_key=${process.env.TMDB_API_KEY}`,
    );

    if (!response.ok) {
      console.error(
        `Failed to fetch episode ${showId} S${season}E${episode}: ${response.status}`,
      );
      return null;
    }

    return response.json();
  } catch (error) {
    console.error(
      `Error fetching episode ${showId} S${season}E${episode}:`,
      error,
    );
    return null;
  }
}

/**
 * Enrich a media item with TMDB data
 */
export async function enrichMediaItem(item: any): Promise<any> {
  if (!item || !item.id) return item;

  const enrichedItem = { ...item };

  if (item.media_type === "movie") {
    const tmdbData = await fetchMovieDetails(item.id);
    if (tmdbData) {
      enrichedItem.poster_path = tmdbData.poster_path;
      enrichedItem.vote_average = tmdbData.vote_average;
      enrichedItem.genre_ids = tmdbData.genre_ids;
      if (!enrichedItem.release_date) {
        enrichedItem.release_date = tmdbData.release_date;
      }
      if (!enrichedItem.title) {
        enrichedItem.title = tmdbData.title;
      }
    }
  } else if (item.media_type === "tv") {
    const tmdbData = await fetchShowDetails(item.id);
    if (tmdbData) {
      enrichedItem.poster_path = tmdbData.poster_path;
      enrichedItem.vote_average = tmdbData.vote_average;
      enrichedItem.genre_ids = tmdbData.genre_ids;
      if (!enrichedItem.first_air_date) {
        enrichedItem.first_air_date = tmdbData.first_air_date;
      }
      if (!enrichedItem.name) {
        enrichedItem.name = tmdbData.name;
      }
    }
  }

  return enrichedItem;
}

/**
 * Enrich multiple items in batches (to avoid rate limits)
 */
export async function enrichMediaItems(
  items: Record<string, any>,
  batchSize: number = 5,
  delayMs: number = 250,
): Promise<Record<string, any>> {
  const enrichedItems: Record<string, any> = {};
  const itemKeys = Object.keys(items);

  for (let i = 0; i < itemKeys.length; i += batchSize) {
    const batch = itemKeys.slice(i, i + batchSize);

    // Process batch in parallel
    const enrichedBatch = await Promise.all(
      batch.map(async (key) => {
        const enriched = await enrichMediaItem(items[key]);
        return { key, item: enriched };
      }),
    );

    // Add to result
    enrichedBatch.forEach(({ key, item }) => {
      enrichedItems[key] = item;
    });

    // Delay between batches to respect rate limits
    if (i + batchSize < itemKeys.length) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    console.log(
      `Enriched ${Math.min(i + batchSize, itemKeys.length)}/${itemKeys.length} items`,
    );
  }

  return enrichedItems;
}

/**
 * Enrich episode tracking with TMDB episode data using season-level caching
 *
 * This function:
 * 1. Groups episodes by season
 * 2. Fetches each season from cache or TMDB (one call per season)
 * 3. Enriches episodes from the cached season data
 * 4. Preserves existing `watched` and `watchedAt` fields
 */
export async function enrichEpisodeTracking(
  showId: number,
  episodes: Record<string, any>,
): Promise<Record<string, any>> {
  const enrichedEpisodes: Record<string, any> = { ...episodes };
  const episodeKeys = Object.keys(episodes);

  // Step 1: Group episodes by season
  const episodesBySeason: Record<number, string[]> = {};

  for (const key of episodeKeys) {
    const [seasonStr] = key.split("_");
    const seasonNumber = parseInt(seasonStr, 10);

    if (!episodesBySeason[seasonNumber]) {
      episodesBySeason[seasonNumber] = [];
    }
    episodesBySeason[seasonNumber].push(key);
  }

  const seasonNumbers = Object.keys(episodesBySeason).map(Number);
  console.log(
    `Enriching ${episodeKeys.length} episodes across ${seasonNumbers.length} seasons for show ${showId}`,
  );

  // Step 2: Fetch and enrich each season
  let enrichedCount = 0;
  let skippedCount = 0;
  let alreadyEnrichedCount = 0;

  for (const seasonNumber of seasonNumbers) {
    const seasonCache = await getSeasonFromCacheOrTMDB(showId, seasonNumber);

    if (!seasonCache) {
      // Season is being populated by another request or failed
      skippedCount += episodesBySeason[seasonNumber].length;
      continue;
    }

    // Step 3: Enrich episodes from cache
    for (const key of episodesBySeason[seasonNumber]) {
      const episode = episodes[key];

      // Check if watchedAt needs normalization (is number or string instead of Timestamp)
      const watchedAtNeedsNormalization =
        episode.watchedAt &&
        !(episode.watchedAt instanceof Timestamp) &&
        (typeof episode.watchedAt === "number" ||
          typeof episode.watchedAt === "string");

      // Skip if already fully enriched AND watchedAt is correct format
      if (
        episode.episodeId &&
        episode.episodeName &&
        episode.episodeAirDate &&
        episode.episodeNumber &&
        episode.seasonNumber &&
        episode.tvShowId &&
        !watchedAtNeedsNormalization
      ) {
        alreadyEnrichedCount++;
        continue;
      }

      const [, episodeStr] = key.split("_");
      const episodeNumber = parseInt(episodeStr, 10);

      const cachedEpisode = seasonCache.episodes[episodeNumber.toString()];

      if (cachedEpisode) {
        // Normalize watchedAt to Firestore Timestamp if needed
        let watchedAt = episode.watchedAt;
        if (typeof watchedAt === "number") {
          watchedAt = Timestamp.fromMillis(watchedAt);
        } else if (typeof watchedAt === "string") {
          const date = new Date(watchedAt);
          if (!isNaN(date.getTime())) {
            watchedAt = Timestamp.fromDate(date);
          }
        }

        // Preserve watched and watchedAt, add enriched fields
        enrichedEpisodes[key] = {
          ...episode, // Preserve watched, watchedAt, and any existing fields
          watchedAt, // Overwrite with normalized Timestamp
          episodeId: cachedEpisode.episodeId,
          episodeName: cachedEpisode.episodeName,
          episodeAirDate: cachedEpisode.episodeAirDate,
          episodeNumber: episodeNumber,
          seasonNumber: seasonNumber,
          tvShowId: showId,
          // Note: posterPath is not stored in cache (per requirements)
        };
        enrichedCount++;
      }
    }
  }

  console.log(
    `Enriched ${enrichedCount} episodes for show ${showId} (${alreadyEnrichedCount} already enriched, ${skippedCount} skipped)`,
  );

  return enrichedEpisodes;
}
