// Trakt API Response Types

export interface TraktIds {
  trakt: number;
  slug: string;
  imdb?: string;
  tmdb?: number;
  tvdb?: number;
}

export interface TraktMovie {
  title: string;
  year: number;
  ids: TraktIds;
}

export interface TraktShow {
  title: string;
  year: number;
  ids: TraktIds;
}

export interface TraktEpisode {
  season: number;
  number: number;
  title: string;
  ids: TraktIds;
}

export interface TraktWatchedMovie {
  plays: number;
  last_watched_at: string;
  last_updated_at: string;
  movie: TraktMovie;
}

export interface TraktWatchedShow {
  plays: number;
  last_watched_at: string;
  last_updated_at: string;
  show: TraktShow;
  seasons: TraktWatchedSeason[];
}

export interface TraktWatchedSeason {
  number: number;
  episodes: TraktWatchedEpisode[];
}

export interface TraktWatchedEpisode {
  number: number;
  plays: number;
  last_watched_at: string;
}

export interface TraktRating {
  rated_at: string;
  rating: number; // 1-10
  type: 'movie' | 'show' | 'season' | 'episode';
  movie?: TraktMovie;
  show?: TraktShow;
  episode?: TraktEpisode;
}

export interface TraktList {
  name: string;
  description: string;
  privacy: 'private' | 'friends' | 'public';
  display_numbers: boolean;
  allow_comments: boolean;
  sort_by: string;
  sort_how: string;
  created_at: string;
  updated_at: string;
  item_count: number;
  comment_count: number;
  likes: number;
  ids: TraktIds;
  user: {
    username: string;
    private: boolean;
    name: string;
    vip: boolean;
    vip_ep: boolean;
  };
}

export interface TraktListItem {
  rank: number;
  id: number;
  listed_at: string;
  notes?: string;
  type: 'movie' | 'show' | 'season' | 'episode' | 'person';
  movie?: TraktMovie;
  show?: TraktShow;
  episode?: TraktEpisode;
}

export interface TraktWatchlistItem {
  rank: number;
  id: number;
  listed_at: string;
  notes?: string;
  type: 'movie' | 'show' | 'season' | 'episode';
  movie?: TraktMovie;
  show?: TraktShow;
  episode?: TraktEpisode;
}

export interface TraktFavorite {
  id: number;
  rank: number;
  listed_at: string;
  notes?: string;
  type: 'movie' | 'show';
  movie?: TraktMovie;
  show?: TraktShow;
}

// OAuth Token Response
export interface TraktTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
  created_at: number;
}

// Internal Types for Firebase
export interface FirestoreWatchlistItem {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  status: 'watching' | 'already_watched' | 'to_watch';
  addedAt: FirebaseFirestore.Timestamp;
  lastWatchedAt?: FirebaseFirestore.Timestamp;
  traktId?: number;
  traktPlays?: number;
  title: string;
  releaseYear?: number;
}

export interface FirestoreRating {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  rating: number; // Convert Trakt 1-10 to your rating system
  ratedAt: FirebaseFirestore.Timestamp;
  traktId?: number;
  title: string;
}

export interface FirestoreList {
  name: string;
  description: string;
  createdAt: FirebaseFirestore.Timestamp;
  updatedAt: FirebaseFirestore.Timestamp;
  items: FirestoreListItem[];
  traktId?: number;
  privacy: 'private' | 'public';
}

export interface FirestoreListItem {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  addedAt: FirebaseFirestore.Timestamp;
  title: string;
  traktId?: number;
}

export interface FirestoreFavorite {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  addedAt: FirebaseFirestore.Timestamp;
  traktId?: number;
  title: string;
}

export interface FirestoreEpisodeTracking {
  showTmdbId: number;
  showTitle: string;
  traktShowId?: number;
  seasons: {
    [seasonNumber: string]: {
      episodes: {
        [episodeNumber: string]: {
          watched: boolean;
          watchedAt?: FirebaseFirestore.Timestamp;
          traktPlays?: number;
        };
      };
    };
  };
}

// Sync Status
export interface TraktSyncStatus {
  userId: string;
  lastSyncedAt: FirebaseFirestore.Timestamp;
  status: 'in_progress' | 'completed' | 'failed';
  itemsSynced: {
    movies: number;
    shows: number;
    episodes: number;
    ratings: number;
    lists: number;
    favorites: number;
  };
  errors?: string[];
}