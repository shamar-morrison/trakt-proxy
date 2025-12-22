import { Timestamp } from 'firebase-admin/firestore';
import { db } from './firebase-admin';
import {
  getWatchedMovies,
  getWatchedShows,
  getRatings,
  getUserLists,
  getListItems,
  getWatchlist,
  getFavorites,
  getUserProfile,
} from './trakt-api';
import {
  transformWatchedMovie,
  transformWatchedShow,
  transformEpisodeTracking,
  transformRating,
  transformListItem,
  transformWatchlistItem,
  transformFavorite,
} from '@/lib/logic/transform';
import { FirestoreList, TraktSyncStatus } from '@/utils/types/trakt';

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
  accessToken: string
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
    await updateSyncStatus(userId, 'in_progress', itemsSynced);

    // Get user profile (needed for lists)
    const userProfile = await getUserProfile(accessToken);

    // 1. Sync watched movies
    try {
      const watchedMovies = await getWatchedMovies(accessToken);
      itemsSynced.movies = await syncWatchedMovies(userId, watchedMovies);
    } catch (error) {
      const errorMsg = `Failed to sync watched movies: ${error}`;
      console.error(errorMsg);
      errors.push(errorMsg);
    }

    // 2. Sync watched shows and episodes
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
        lists
      );
    } catch (error) {
      const errorMsg = `Failed to sync custom lists: ${error}`;
      console.error(errorMsg);
      errors.push(errorMsg);
    }

    // Update sync status to completed
    await updateSyncStatus(
      userId,
      errors.length > 0 ? 'failed' : 'completed',
      itemsSynced,
      errors
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

    await updateSyncStatus(userId, 'failed', itemsSynced, errors);

    return {
      success: false,
      itemsSynced,
      errors,
    };
  }
}

/**
 * Sync watched movies to Firestore
 */
async function syncWatchedMovies(
  userId: string,
  traktMovies: Awaited<ReturnType<typeof getWatchedMovies>>
): Promise<number> {
  const batch = db.batch();
  let count = 0;

  for (const traktMovie of traktMovies) {
    const movie = transformWatchedMovie(traktMovie);
    if (movie) {
      const docRef = db
        .collection('users')
        .doc(userId)
        .collection('watchlist')
        .doc(`movie_${movie.tmdbId}`);

      batch.set(docRef, movie, { merge: true });
      count++;
    }
  }

  if (count > 0) {
    await batch.commit();
  }

  return count;
}

/**
 * Sync watched shows and episode tracking
 */
async function syncWatchedShows(
  userId: string,
  traktShows: Awaited<ReturnType<typeof getWatchedShows>>
): Promise<{ shows: number; episodes: number }> {
  const watchlistBatch = db.batch();
  const episodeBatch = db.batch();
  let showCount = 0;
  let episodeCount = 0;

  for (const traktShow of traktShows) {
    // Add to watchlist
    const show = transformWatchedShow(traktShow);
    if (show) {
      const watchlistRef = db
        .collection('users')
        .doc(userId)
        .collection('watchlist')
        .doc(`tv_${show.tmdbId}`);

      watchlistBatch.set(watchlistRef, show, { merge: true });
      showCount++;
    }

    // Add episode tracking
    const episodeTracking = transformEpisodeTracking(traktShow);
    if (episodeTracking) {
      const episodeRef = db
        .collection('users')
        .doc(userId)
        .collection('episode_tracking')
        .doc(episodeTracking.showTmdbId.toString());

      episodeBatch.set(episodeRef, episodeTracking, { merge: true });

      // Count total episodes
      Object.values(episodeTracking.seasons).forEach((season) => {
        episodeCount += Object.keys(season.episodes).length;
      });
    }
  }

  if (showCount > 0) {
    await watchlistBatch.commit();
  }
  if (episodeCount > 0) {
    await episodeBatch.commit();
  }

  return { shows: showCount, episodes: episodeCount };
}

/**
 * Sync ratings to Firestore
 */
async function syncRatings(
  userId: string,
  traktRatings: Awaited<ReturnType<typeof getRatings>>
): Promise<number> {
  const batch = db.batch();
  let count = 0;

  for (const traktRating of traktRatings) {
    const rating = transformRating(traktRating);
    if (rating) {
      const docRef = db
        .collection('users')
        .doc(userId)
        .collection('ratings')
        .doc(`${rating.mediaType}_${rating.tmdbId}`);

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
 */
async function syncWatchlist(
  userId: string,
  traktWatchlist: Awaited<ReturnType<typeof getWatchlist>>
): Promise<number> {
  const batch = db.batch();
  let count = 0;

  for (const traktItem of traktWatchlist) {
    const item = transformWatchlistItem(traktItem);
    if (item) {
      const docRef = db
        .collection('users')
        .doc(userId)
        .collection('watchlist')
        .doc(`${item.mediaType}_${item.tmdbId}`);

      batch.set(docRef, item, { merge: true });
      count++;
    }
  }

  if (count > 0) {
    await batch.commit();
  }

  return count;
}

/**
 * Sync favorites to Firestore
 */
async function syncFavorites(
  userId: string,
  traktFavorites: Awaited<ReturnType<typeof getFavorites>>
): Promise<number> {
  const batch = db.batch();
  let count = 0;

  for (const traktFavorite of traktFavorites) {
    const favorite = transformFavorite(traktFavorite);
    if (favorite) {
      const docRef = db
        .collection('users')
        .doc(userId)
        .collection('favorites')
        .doc(`${favorite.mediaType}_${favorite.tmdbId}`);

      batch.set(docRef, favorite, { merge: true });
      count++;
    }
  }

  if (count > 0) {
    await batch.commit();
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
  traktLists: Awaited<ReturnType<typeof getUserLists>>
): Promise<number> {
  let count = 0;

  // Process each list sequentially to avoid overwhelming Firestore
  for (const traktList of traktLists) {
    try {
      // Get list items
      const listItems = await getListItems(
        accessToken,
        username,
        traktList.ids.slug
      );

      // Transform list items
      const items = listItems
        .map(transformListItem)
        .filter((item) => item !== null);

      // Create Firestore list document
      const firestoreList: FirestoreList = {
        name: traktList.name,
        description: traktList.description || '',
        createdAt: Timestamp.fromDate(new Date(traktList.created_at)),
        updatedAt: Timestamp.fromDate(new Date(traktList.updated_at)),
        items: items as any[],
        traktId: traktList.ids.trakt,
        privacy: traktList.privacy === 'public' ? 'public' : 'private',
      };

      // Save to Firestore
      const docRef = db
        .collection('users')
        .doc(userId)
        .collection('lists')
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
  status: TraktSyncStatus['status'],
  itemsSynced: TraktSyncStatus['itemsSynced'],
  errors?: string[]
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

  await db
    .collection('users')
    .doc(userId)
    .update({
      traktSyncStatus: syncStatus,
    });
}