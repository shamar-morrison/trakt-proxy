import { Timestamp } from "firebase-admin/firestore";
import { db } from "./firebase-admin";
import {
  getWatchedMovies,
  getWatchedShows,
  getRatings,
  getUserLists,
  getListItems,
  getWatchlist,
  getFavorites,
  getUserProfile,
} from "./trakt-api";
import {
  transformWatchedMovie,
  transformWatchedShow,
  transformEpisodeTracking,
  transformRating,
  transformListItem,
  transformWatchlistItem,
  transformFavorite,
} from "@/lib/logic/transform";
import { enrichMediaItems } from "@/lib/tmdb-enrich";
import { TraktSyncStatus } from "@/utils/types/trakt";

interface SyncResult {
  success: boolean;
  itemsSynced: {
    movies: number;
    shows: number;
    episodes: number;
    ratings: number;
    lists: number;
    favorites: number;
    watchlistItems: number;
  };
  errors: string[];
}

/**
 * Main function to sync all Trakt data for a user
 */
export async function syncTraktData(
  userId: string,
  accessToken: string,
): Promise<SyncResult> {
  const errors: string[] = [];
  const itemsSynced = {
    movies: 0,
    shows: 0,
    episodes: 0,
    ratings: 0,
    lists: 0,
    favorites: 0,
    watchlistItems: 0,
  };

  try {
    // Update sync status to in_progress
    await updateSyncStatus(userId, "in_progress", itemsSynced);

    // Get user profile (needed for lists)
    const userProfile = await getUserProfile(accessToken);

    // Collect all already-watched items (movies + shows) before writing
    const allAlreadyWatchedItems: Record<string, any> = {};

    // 1. Sync watched movies and collect for already-watched
    // 1. Sync watched movies and collect for already-watched
    try {
      const watchedMovies = await getWatchedMovies(accessToken);
      for (const traktMovie of watchedMovies) {
        const item = transformWatchedMovie(traktMovie);
        if (item) {
          allAlreadyWatchedItems[item.id.toString()] = item;
          itemsSynced.movies++;
        }
      }
    } catch (error) {
      const errorMsg = `Failed to sync watched movies: ${error}`;
      console.error(errorMsg);
      errors.push(errorMsg);
    }

    // 2. Sync watched shows, episode tracking, and collect for already-watched
    try {
      const watchedShows = await getWatchedShows(accessToken);
      const { shows, episodes, alreadyWatchedShows } = await syncWatchedShows(
        userId,
        watchedShows,
      );
      itemsSynced.shows = shows;
      itemsSynced.episodes = episodes;

      // Add shows to already-watched collection
      Object.assign(allAlreadyWatchedItems, alreadyWatchedShows);
    } catch (error) {
      const errorMsg = `Failed to sync watched shows: ${error}`;
      console.error(errorMsg);
      errors.push(errorMsg);
    }

    // Write all already-watched items at once
    if (Object.keys(allAlreadyWatchedItems).length > 0) {
      const alreadyWatchedRef = db
        .collection("users")
        .doc(userId)
        .collection("lists")
        .doc("already-watched");

      await alreadyWatchedRef.set(
        {
          id: "already-watched",
          name: "Already Watched",
          createdAt: Timestamp.now(),
          items: allAlreadyWatchedItems,
          metadata: {
            lastUpdated: Timestamp.now(),
            itemCount: Object.keys(allAlreadyWatchedItems).length,
          },
        },
        { merge: true },
      );
    }

    // 3. Sync ratings
    try {
      const ratings = await getRatings(accessToken);
      itemsSynced.ratings = await syncRatings(userId, ratings);
    } catch (error) {
      const errorMsg = `Failed to sync ratings: ${error}`;
      console.error(errorMsg);
      errors.push(errorMsg);
    }

    // 4. Sync watchlist
    try {
      const watchlist = await getWatchlist(accessToken);
      itemsSynced.watchlistItems = await syncWatchlist(userId, watchlist);
    } catch (error) {
      const errorMsg = `Failed to sync watchlist: ${error}`;
      console.error(errorMsg);
      errors.push(errorMsg);
    }

    // 5. Sync favorites
    try {
      const favorites = await getFavorites(accessToken);
      itemsSynced.favorites = await syncFavorites(userId, favorites);
    } catch (error) {
      const errorMsg = `Failed to sync favorites: ${error}`;
      console.error(errorMsg);
      errors.push(errorMsg);
    }

    // 6. Sync custom lists
    try {
      const lists = await getUserLists(accessToken, userProfile.username);
      itemsSynced.lists = await syncCustomLists(
        userId,
        accessToken,
        userProfile.username,
        lists,
      );
    } catch (error) {
      const errorMsg = `Failed to sync custom lists: ${error}`;
      console.error(errorMsg);
      errors.push(errorMsg);
    }

    // Update sync status to completed
    await updateSyncStatus(
      userId,
      errors.length > 0 ? "failed" : "completed",
      itemsSynced,
      errors,
    );

    return {
      success: errors.length === 0,
      itemsSynced,
      errors,
    };
  } catch (error) {
    const errorMsg = `Fatal sync error: ${error}`;
    console.error(errorMsg);
    errors.push(errorMsg);

    await updateSyncStatus(userId, "failed", itemsSynced, errors);

    return {
      success: false,
      itemsSynced,
      errors,
    };
  }
}

/**
 * Sync watched shows and episode tracking
 * Returns already-watched items for consolidation with movies
 */
async function syncWatchedShows(
  userId: string,
  traktShows: Awaited<ReturnType<typeof getWatchedShows>>,
): Promise<{
  shows: number;
  episodes: number;
  alreadyWatchedShows: Record<string, any>;
}> {
  const episodeBatch = db.batch();
  const alreadyWatchedShows: Record<string, any> = {};
  let showCount = 0;
  let episodeCount = 0;

  for (const traktShow of traktShows) {
    // Add episode tracking
    const episodeTracking = transformEpisodeTracking(traktShow);
    if (episodeTracking && traktShow.show.ids.tmdb) {
      const episodeRef = db
        .collection("users")
        .doc(userId)
        .collection("episode_tracking")
        .doc(traktShow.show.ids.tmdb.toString());

      episodeBatch.set(episodeRef, episodeTracking, { merge: true });

      episodeCount += Object.keys(episodeTracking.episodes).length;
      showCount++;
    }

    // Collect for already-watched list
    const watchedShow = transformWatchedShow(traktShow);
    if (watchedShow) {
      alreadyWatchedShows[watchedShow.id.toString()] = watchedShow;
    }
  }

  if (showCount > 0) {
    await episodeBatch.commit();
  }

  return { shows: showCount, episodes: episodeCount, alreadyWatchedShows };
}

/**
 * Sync ratings to Firestore
 */
async function syncRatings(
  userId: string,
  traktRatings: Awaited<ReturnType<typeof getRatings>>,
): Promise<number> {
  const batch = db.batch();
  let count = 0;

  for (const traktRating of traktRatings) {
    const rating = transformRating(traktRating);
    if (rating) {
      const docRef = db
        .collection("users")
        .doc(userId)
        .collection("ratings")
        .doc(rating.id); // Already includes hyphen: "movie-123" or "tv-456"

      batch.set(docRef, rating, { merge: true });
      count++;
    }
  }

  if (count > 0) {
    await batch.commit();
  }

  return count;
}

/**
 * Sync watchlist to Firestore
 * Stores as items map inside lists/watchlist document
 */
async function syncWatchlist(
  userId: string,
  traktWatchlist: Awaited<ReturnType<typeof getWatchlist>>,
): Promise<number> {
  const items: Record<string, any> = {};
  let count = 0;

  for (const traktItem of traktWatchlist) {
    const item = transformWatchlistItem(traktItem);
    if (item) {
      items[item.id.toString()] = item;
      count++;
    }
  }

  if (count > 0) {
    const watchlistRef = db
      .collection("users")
      .doc(userId)
      .collection("lists")
      .doc("watchlist");

    await watchlistRef.set(
      {
        items,
        metadata: {
          lastUpdated: Timestamp.now(),
          itemCount: count,
        },
      },
      { merge: true },
    );
  }

  return count;
}

/**
 * Sync favorites to Firestore
 * Stores as items map inside lists/favorites document
 */
async function syncFavorites(
  userId: string,
  traktFavorites: Awaited<ReturnType<typeof getFavorites>>,
): Promise<number> {
  const items: Record<string, any> = {};
  let count = 0;

  for (const traktFavorite of traktFavorites) {
    const favorite = transformFavorite(traktFavorite);
    if (favorite) {
      items[favorite.id.toString()] = favorite;
      count++;
    }
  }

  if (count > 0) {
    const favoritesRef = db
      .collection("users")
      .doc(userId)
      .collection("lists")
      .doc("favorites");

    await favoritesRef.set(
      {
        items,
        metadata: {
          lastUpdated: Timestamp.now(),
          itemCount: count,
        },
      },
      { merge: true },
    );
  }

  return count;
}

/**
 * Sync custom lists to Firestore
 */
async function syncCustomLists(
  userId: string,
  accessToken: string,
  username: string,
  traktLists: Awaited<ReturnType<typeof getUserLists>>,
): Promise<number> {
  let count = 0;

  // Process each list sequentially to avoid overwhelming Firestore
  for (const traktList of traktLists) {
    try {
      // Get list items
      const listItems = await getListItems(
        accessToken,
        username,
        traktList.ids.slug,
      );

      // Transform list items to format compatible with enrichment
      // Use Record<string, any> keyed by TMDB ID (matching other lists like already-watched)
      const items: Record<string, any> = {};

      for (const traktItem of listItems) {
        const transformed = transformListItem(traktItem);
        if (transformed) {
          // Convert to format expected by enrichMediaItem and frontend
          // Key by TMDB ID for consistency with other lists
          items[transformed.tmdbId.toString()] = {
            id: transformed.tmdbId,
            media_type: transformed.mediaType,
            title: transformed.title,
            addedAt: transformed.addedAt,
            traktId: transformed.traktId,
          };
        }
      }

      // Enrich items with TMDB data (poster_path, genre_ids, vote_average, release_date)
      const enrichedItems = await enrichMediaItems(items);

      // Save to Firestore with consistent structure
      const docRef = db
        .collection("users")
        .doc(userId)
        .collection("lists")
        .doc(`trakt_${traktList.ids.trakt}`);

      await docRef.set({
        name: traktList.name,
        description: traktList.description || "",
        createdAt: new Date(traktList.created_at).getTime(),
        updatedAt: new Date(traktList.updated_at).getTime(),
        items: enrichedItems,
        traktId: traktList.ids.trakt,
        privacy: traktList.privacy === "public" ? "public" : "private",
        isCustom: true, // Mark as custom list from Trakt
        metadata: {
          lastUpdated: Date.now(),
          itemCount: Object.keys(enrichedItems).length,
        },
      });

      count++;
      console.log(
        `Synced custom list "${traktList.name}" with ${Object.keys(enrichedItems).length} items`,
      );
    } catch (error) {
      console.error(`Failed to sync list "${traktList.name}":`, error);
    }
  }

  return count;
}

/**
 * Update sync status in Firestore
 */
async function updateSyncStatus(
  userId: string,
  status: TraktSyncStatus["status"],
  itemsSynced: TraktSyncStatus["itemsSynced"],
  errors?: string[],
): Promise<void> {
  const syncStatus: Partial<TraktSyncStatus> = {
    userId,
    lastSyncedAt: Timestamp.now(),
    status,
    itemsSynced,
  };

  if (errors && errors.length > 0) {
    syncStatus.errors = errors;
  }

  await db.collection("users").doc(userId).update({
    traktSyncStatus: syncStatus,
  });
}
