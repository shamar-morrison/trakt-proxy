# TMDB Season-Level Caching – Implementation Prompt

You are implementing **season-level TMDB caching** in an existing **Next.js proxy** (`trakt-proxy`) that enriches user episode data stored in Firestore.

---

## Context

- Firestore is already initialized and used
- Episode data lives at:

  ```
  users/{userId}/episode_tracking/{tmdbShowId}
  ```

- Each document contains an `episodes` map keyed as:

  ```
  "{seasonNumber}_{episodeNumber}"  // e.g. "1_1"
  ```

- Episode shape:

  ```ts
  {
    watched: boolean
    watchedAt: Timestamp
    episodeId?: number
    episodeName?: string
    episodeAirDate?: string
    posterPath?: string
  }
  ```

- `tmdbShowId` is already known and is the document ID
- TMDB enrichment currently fetches **per-episode** data using:

  ```
  GET /tv/{id}/season/{season}/episode/{episode}
  ```

- All episode metadata must come from TMDB
- Localization is **not** implemented (default TMDB language only)

---

## Goal

Replace per-episode TMDB calls with **season-level caching** in Firestore to:

- Reduce TMDB API usage
- Avoid rate limits under concurrent user syncs
- Share cached TMDB data across all users

---

## Firestore Cache Schema (NEW – must use exactly this)

```
tmdb_cache/
  tv/
    seasons/{tmdbShowId}_{seasonNumber}
  movie/ (future)
    details/{movieId}
```

### Season document shape

```ts
{
  episodes: {
    [episodeNumber: string]: {
      episodeId: number
      episodeName: string
      episodeAirDate: string | null
    }
  }
  lastUpdated: Timestamp
  status: "complete" | "populating"
}
```

Notes:

- This cache is **global** (no user IDs)
- Store **only** required episode fields
- Do not store posters, cast, or large payloads

---

## Required Behavior

### 1. Cache helper

Implement a reusable helper:

```ts
getSeasonFromCacheOrTMDB(
  tmdbShowId: number,
  seasonNumber: number
): Promise<SeasonCache>
```

---

### 2. Cache lookup logic

1. Check Firestore for `tmdb_cache/tv/seasons/{tmdbShowId}_{seasonNumber}`
2. If the document exists and:
   - `status === "complete"`
   - Cache is **not stale**
     → return cached data

3. If the document is missing or stale:
   - Set `status = "populating"`
   - Fetch season data from TMDB:

     ```
     GET /tv/{tmdbShowId}/season/{seasonNumber}
     ```

   - Extract and store **only**:
     - `episode_number`
     - `id`
     - `name`
     - `air_date`

   - Write data to Firestore
   - Set `status = "complete"`

---

### 3. Concurrency safety

If another request sees:

```ts
status === "populating";
```

It must:

- **NOT** refetch from TMDB
- Either:
  - Skip enrichment for now, or
  - Retry later

This prevents duplicate TMDB calls.

---

### 4. Cache freshness (TTL)

- Default TTL: **30 days**
- If season appears ongoing (latest episode has no air date or very recent): **7 days**

---

## Enrichment Integration

Update existing enrichment logic so that:

1. Seasons are detected from episode keys:

   ```
   "1_1" → season 1, episode 1
   ```

2. Group missing episodes by season
3. For each season:
   - Load season data using `getSeasonFromCacheOrTMDB`
   - Enrich all episodes in that season locally

4. Merge enriched fields into:

   ```
   users/{userId}/episode_tracking/{tmdbShowId}
   ```

5. **Never overwrite**:
   - `watched`
   - `watchedAt`

---

## Constraints

- TypeScript only
- No UI code
- No Firebase auth changes
- Minimize Firestore reads and writes
- Do not duplicate user episode data into cache
- Code must be production-safe and readable

---

## Output Required

- `getSeasonFromCacheOrTMDB` helper implementation
- Updated enrichment logic using season-level cache
- Clean, production-ready code suitable for a Next.js API layer

---

## Success Criteria

- TMDB is called **once per season**, not per episode
- Concurrent user syncs do not cause TMDB request spikes
- Existing Firestore user data structure remains unchanged
- Cache is reusable across all users
