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
 * Convert Trakt watched movie to Firestore watchlist item
 */
export function transformWatchedMovie(
  traktMovie: TraktWatchedMovie,
): FirestoreWatchlistItem | null {
  // Skip if no TMDB ID
  if (!traktMovie.movie.ids.tmdb) {
    console.warn(`Movie "${traktMovie.movie.title}" has no TMDB ID, skipping`);
    return null;
  }

  return {
    tmdbId: traktMovie.movie.ids.tmdb,
    mediaType: "movie",
    status: "already_watched",
    addedAt: Timestamp.fromDate(new Date(traktMovie.last_watched_at)),
    lastWatchedAt: Timestamp.fromDate(new Date(traktMovie.last_watched_at)),
    traktId: traktMovie.movie.ids.trakt,
    traktPlays: traktMovie.plays,
    title: traktMovie.movie.title,
    releaseYear: traktMovie.movie.year,
  };
}

/**
 * Convert Trakt watched show to Firestore watchlist item
 */
export function transformWatchedShow(
  traktShow: TraktWatchedShow,
): FirestoreWatchlistItem | null {
  if (!traktShow.show.ids.tmdb) {
    console.warn(`Show "${traktShow.show.title}" has no TMDB ID, skipping`);
    return null;
  }

  return {
    tmdbId: traktShow.show.ids.tmdb,
    mediaType: "tv",
    status: "already_watched",
    addedAt: Timestamp.fromDate(new Date(traktShow.last_watched_at)),
    lastWatchedAt: Timestamp.fromDate(new Date(traktShow.last_watched_at)),
    traktId: traktShow.show.ids.trakt,
    traktPlays: traktShow.plays,
    title: traktShow.show.title,
    releaseYear: traktShow.show.year,
  };
}

/**
 * Convert Trakt watched show to episode tracking data
 */
export function transformEpisodeTracking(
  traktShow: TraktWatchedShow,
): FirestoreEpisodeTracking | null {
  if (!traktShow.show.ids.tmdb) {
    return null;
  }

  const seasons: FirestoreEpisodeTracking["seasons"] = {};

  traktShow.seasons.forEach((season) => {
    const seasonKey = season.number.toString();
    seasons[seasonKey] = { episodes: {} };

    season.episodes.forEach((episode) => {
      const episodeKey = episode.number.toString();
      seasons[seasonKey].episodes[episodeKey] = {
        watched: true,
        watchedAt: Timestamp.fromDate(new Date(episode.last_watched_at)),
        traktPlays: episode.plays,
      };
    });
  });

  return {
    showTmdbId: traktShow.show.ids.tmdb,
    showTitle: traktShow.show.title,
    traktShowId: traktShow.show.ids.trakt,
    seasons,
  };
}

/**
 * Convert Trakt rating to Firestore rating
 * Converts Trakt's 1-10 scale to your app's rating system
 */
export function transformRating(
  traktRating: TraktRating,
): FirestoreRating | null {
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

  // Convert Trakt's 1-10 rating to your app's scale
  // Adjust this conversion based on your app's rating system
  // If you use 5 stars: rating / 2
  // If you use 10 stars: keep as is
  const convertedRating = traktRating.rating; // Assuming 10-star system

  return {
    tmdbId,
    mediaType,
    rating: convertedRating,
    ratedAt: Timestamp.fromDate(new Date(traktRating.rated_at)),
    traktId: traktRating.movie?.ids.trakt || traktRating.show?.ids.trakt,
    title,
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
 */
export function transformWatchlistItem(
  traktItem: TraktWatchlistItem,
): FirestoreWatchlistItem | null {
  let tmdbId: number | undefined;
  let mediaType: "movie" | "tv";
  let title: string;
  let releaseYear: number | undefined;
  let traktId: number | undefined;

  if (traktItem.movie) {
    tmdbId = traktItem.movie.ids.tmdb;
    mediaType = "movie";
    title = traktItem.movie.title;
    releaseYear = traktItem.movie.year;
    traktId = traktItem.movie.ids.trakt;
  } else if (traktItem.show) {
    tmdbId = traktItem.show.ids.tmdb;
    mediaType = "tv";
    title = traktItem.show.title;
    releaseYear = traktItem.show.year;
    traktId = traktItem.show.ids.trakt;
  } else {
    return null;
  }

  if (!tmdbId) {
    console.warn(`Watchlist item "${title}" has no TMDB ID, skipping`);
    return null;
  }

  return {
    tmdbId,
    mediaType,
    status: "to_watch",
    addedAt: Timestamp.fromDate(new Date(traktItem.listed_at)),
    traktId,
    title,
    releaseYear,
  };
}

/**
 * Convert Trakt favorite to Firestore favorite
 */
export function transformFavorite(
  traktFavorite: TraktFavorite,
): FirestoreFavorite | null {
  let tmdbId: number | undefined;
  let mediaType: "movie" | "tv";
  let title: string;
  let traktId: number | undefined;

  if (traktFavorite.movie) {
    tmdbId = traktFavorite.movie.ids.tmdb;
    mediaType = "movie";
    title = traktFavorite.movie.title;
    traktId = traktFavorite.movie.ids.trakt;
  } else if (traktFavorite.show) {
    tmdbId = traktFavorite.show.ids.tmdb;
    mediaType = "tv";
    title = traktFavorite.show.title;
    traktId = traktFavorite.show.ids.trakt;
  } else {
    return null;
  }

  if (!tmdbId) {
    console.warn(`Favorite "${title}" has no TMDB ID, skipping`);
    return null;
  }

  return {
    tmdbId,
    mediaType,
    addedAt: Timestamp.fromDate(new Date(traktFavorite.listed_at)),
    traktId,
    title,
  };
}
