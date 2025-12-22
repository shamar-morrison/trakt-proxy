import { Timestamp } from "firebase-admin/firestore";
import {
  TraktWatchedMovie,
  TraktWatchedShow,
  TraktRating,
  TraktListItem,
  TraktWatchlistItem,
  TraktFavorite,
  FirestoreWatchlistItem,
  FirestoreRating,
  FirestoreListItem,
  FirestoreFavorite,
  FirestoreEpisodeTracking,
} from "@/utils/types/trakt";

/**
 * Convert Trakt watched show to episode tracking data
 * Matches your flat episode structure: episodes.{season}_{episode}
 */
export function transformEpisodeTracking(traktShow: TraktWatchedShow) {
  if (!traktShow.show.ids.tmdb) {
    return null;
  }

  const episodes: Record<
    string,
    {
      watched: boolean;
      watchedAt: any;
      episodeId?: number;
      posterPath?: string;
      episodeName?: string;
      episodeAirDate?: string;
    }
  > = {};

  traktShow.seasons.forEach((season) => {
    season.episodes.forEach((episode) => {
      const episodeKey = `${season.number}_${episode.number}`;
      episodes[episodeKey] = {
        watched: true,
        watchedAt: Timestamp.fromDate(new Date(episode.last_watched_at)),
      };
    });
  });

  return {
    episodes,
    metadata: {
      tvShowName: traktShow.show.title,
      lastUpdated: Timestamp.now(),
    },
  };
}

/**
 * Convert Trakt watched movie to already-watched item
 */
export function transformWatchedMovie(traktMovie: TraktWatchedMovie) {
  if (!traktMovie.movie.ids.tmdb) {
    console.warn(`Movie "${traktMovie.movie.title}" has no TMDB ID, skipping`);
    return null;
  }

  return {
    id: traktMovie.movie.ids.tmdb,
    media_type: "movie",
    title: traktMovie.movie.title,
    release_date: traktMovie.movie.year
      ? `${traktMovie.movie.year}-01-01`
      : undefined,
    addedAt: Timestamp.fromDate(new Date(traktMovie.last_watched_at)),
    // TMDB fields to be enriched:
    // poster_path, vote_average, genre_ids
  };
}

/**
 * Convert Trakt watched show to already-watched item
 */
export function transformWatchedShow(traktShow: TraktWatchedShow) {
  if (!traktShow.show.ids.tmdb) {
    console.warn(`Show "${traktShow.show.title}" has no TMDB ID, skipping`);
    return null;
  }

  return {
    id: traktShow.show.ids.tmdb,
    media_type: "tv",
    name: traktShow.show.title, // TV shows use 'name' field
    first_air_date: traktShow.show.year
      ? `${traktShow.show.year}-01-01`
      : undefined,
    addedAt: Timestamp.fromDate(new Date(traktShow.last_watched_at)),
    // TMDB fields to be enriched:
    // poster_path, vote_average, genre_ids
  };
}

/**
 * Convert Trakt rating to Firestore rating
 * Document ID format: {mediaType}-{tmdbId} (with hyphen)
 */
export function transformRating(traktRating: TraktRating) {
  let tmdbId: number | undefined;
  let mediaType: "movie" | "tv";
  let title: string;

  // Determine media type and get TMDB ID
  if (traktRating.movie) {
    tmdbId = traktRating.movie.ids.tmdb;
    mediaType = "movie";
    title = traktRating.movie.title;
  } else if (traktRating.show) {
    tmdbId = traktRating.show.ids.tmdb;
    mediaType = "tv";
    title = traktRating.show.title;
  } else {
    // Skip episodes and seasons
    return null;
  }

  if (!tmdbId) {
    console.warn(`Rating for "${title}" has no TMDB ID, skipping`);
    return null;
  }

  // Convert Trakt's 1-10 rating to 5-star system
  const convertedRating = traktRating.rating / 2;

  return {
    id: `${mediaType}-${tmdbId}`, // Must match document ID
    media_type: mediaType,
    rating: convertedRating,
    ratedAt: Timestamp.fromDate(new Date(traktRating.rated_at)),
    title,
    // These fields should be fetched from TMDB if needed:
    // posterPath, releaseDate
  };
}

/**
 * Convert Trakt list item to Firestore list item
 */
export function transformListItem(
  traktItem: TraktListItem,
): FirestoreListItem | null {
  let tmdbId: number | undefined;
  let mediaType: "movie" | "tv";
  let title: string;
  let traktId: number | undefined;

  if (traktItem.movie) {
    tmdbId = traktItem.movie.ids.tmdb;
    mediaType = "movie";
    title = traktItem.movie.title;
    traktId = traktItem.movie.ids.trakt;
  } else if (traktItem.show) {
    tmdbId = traktItem.show.ids.tmdb;
    mediaType = "tv";
    title = traktItem.show.title;
    traktId = traktItem.show.ids.trakt;
  } else {
    // Skip episodes, seasons, persons
    return null;
  }

  if (!tmdbId) {
    console.warn(`List item "${title}" has no TMDB ID, skipping`);
    return null;
  }

  return {
    tmdbId,
    mediaType,
    addedAt: Timestamp.fromDate(new Date(traktItem.listed_at)),
    title,
    traktId,
  };
}

/**
 * Convert Trakt watchlist item to Firestore watchlist item
 * These will be stored as items in lists/watchlist document
 */
export function transformWatchlistItem(traktItem: TraktWatchlistItem) {
  let tmdbId: number | undefined;
  let mediaType: "movie" | "tv";
  let title: string;
  let releaseDate: string | undefined;

  if (traktItem.movie) {
    tmdbId = traktItem.movie.ids.tmdb;
    mediaType = "movie";
    title = traktItem.movie.title;
    releaseDate = traktItem.movie.year
      ? `${traktItem.movie.year}-01-01`
      : undefined;
  } else if (traktItem.show) {
    tmdbId = traktItem.show.ids.tmdb;
    mediaType = "tv";
    title = traktItem.show.title;
    releaseDate = traktItem.show.year
      ? `${traktItem.show.year}-01-01`
      : undefined;
  } else {
    return null;
  }

  if (!tmdbId) {
    console.warn(`Watchlist item "${title}" has no TMDB ID, skipping`);
    return null;
  }

  return {
    id: tmdbId,
    media_type: mediaType, // snake_case
    title,
    release_date: releaseDate,
    addedAt: Timestamp.fromDate(new Date(traktItem.listed_at)),
    // These fields should be fetched from TMDB:
    // poster_path, vote_average, genre_ids
  };
}

/**
 * Convert Trakt favorite to Firestore favorite item
 * These will be stored as items in lists/favorites document
 */
export function transformFavorite(traktFavorite: TraktFavorite) {
  let tmdbId: number | undefined;
  let mediaType: "movie" | "tv";
  let title: string;

  if (traktFavorite.movie) {
    tmdbId = traktFavorite.movie.ids.tmdb;
    mediaType = "movie";
    title = traktFavorite.movie.title;
  } else if (traktFavorite.show) {
    tmdbId = traktFavorite.show.ids.tmdb;
    mediaType = "tv";
    title = traktFavorite.show.title;
  } else {
    return null;
  }

  if (!tmdbId) {
    console.warn(`Favorite "${title}" has no TMDB ID, skipping`);
    return null;
  }

  return {
    id: tmdbId,
    media_type: mediaType, // snake_case
    title,
    addedAt: Timestamp.fromDate(new Date(traktFavorite.listed_at)),
    // These fields should be fetched from TMDB:
    // poster_path, vote_average, release_date, genre_ids
  };
}
