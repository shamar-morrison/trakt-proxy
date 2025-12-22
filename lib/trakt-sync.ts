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
import { FirestoreList, TraktSyncStatus } from "@/utils/types/trakt";

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

    // 1. Sync watched movies to already-watched
    try {
      const watchedMovies = await getWatchedMovies(accessToken);
      itemsSynced.movies = await syncAlreadyWatched(
        userId,
        watchedMovies,
        "movies",
      );
    } catch (error) {
      const errorMsg = `Failed to sync watched movies: ${error}`;
      console.error(errorMsg);
      errors.push(errorMsg);
    }

    // 2. Sync watched shows to already-watched and episode tracking
    try {
      const watchedShows = await getWatchedShows(accessToken);
      const { shows, episodes } = await syncWatchedShows(userId, watchedShows);
      itemsSynced.shows = shows;
      itemsSynced.episodes = episodes;
    } catch (error) {
      const errorMsg = `Failed to sync watched shows: ${error}`;
      console.error(errorMsg);
      errors.push(errorMsg);
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
 * Sync already watched items (movies or shows) to lists/already-watched
 */
async function syncAlreadyWatched(
  userId: string,
  traktMovies: Awaited<ReturnType<typeof getWatchedMovies>>,
  type: "movies",
): Promise<number> {
  const items: Record<string, any> = {};
  let count = 0;

  for (const traktMovie of traktMovies) {
    const item = transformWatchedMovie(traktMovie);
    if (item) {
      const itemKey = `movie-${item.id}`;
      items[itemKey] = item;
      count++;
    }
  }

  if (count > 0) {
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
        items,
      },
      { merge: true },
    );
  }

  return count;
}

/**
 * Sync watched shows and episode tracking
 */
async function syncWatchedShows(
  userId: string,
  traktShows: Awaited<ReturnType<typeof getWatchedShows>>,
): Promise<{ shows: number; episodes: number }> {
  const episodeBatch = db.batch();
  const alreadyWatchedItems: Record<string, any> = {};
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
        .doc(traktShow.show.ids.tmdb.toString()); // Use TMDB ID as doc ID

      episodeBatch.set(episodeRef, episodeTracking, { merge: true });

      // Count episodes
      episodeCount += Object.keys(episodeTracking.episodes).length;
      showCount++;
    }

    // Add to already-watched list
    const watchedShow = transformWatchedShow(traktShow);
    if (watchedShow) {
      const itemKey = `tv-${watchedShow.id}`;
      alreadyWatchedItems[itemKey] = watchedShow;
    }
  }

  if (showCount > 0) {
    await episodeBatch.commit();
  }

  // Add shows to already-watched list
  if (Object.keys(alreadyWatchedItems).length > 0) {
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
        items: alreadyWatchedItems,
      },
      { merge: true },
    );
  }

  return { shows: showCount, episodes: episodeCount };
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
      const itemKey = `${item.media_type}-${item.id}`;
      items[itemKey] = item;
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
      const itemKey = `${favorite.media_type}-${favorite.id}`;
      items[itemKey] = favorite;
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

      // Transform list items
      const items = listItems
        .map(transformListItem)
        .filter((item) => item !== null);

      // Create Firestore list document
      const firestoreList: FirestoreList = {
        name: traktList.name,
        description: traktList.description || "",
        createdAt: Timestamp.fromDate(new Date(traktList.created_at)),
        updatedAt: Timestamp.fromDate(new Date(traktList.updated_at)),
        items: items as any[],
        traktId: traktList.ids.trakt,
        privacy: traktList.privacy === "public" ? "public" : "private",
      };

      // Save to Firestore
      const docRef = db
        .collection("users")
        .doc(userId)
        .collection("lists")
        .doc(`trakt_${traktList.ids.trakt}`);

      await docRef.set(firestoreList);
      count++;
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
