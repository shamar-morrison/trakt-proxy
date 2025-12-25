import { NextRequest, NextResponse } from "next/server";
import { Timestamp } from "firebase-admin/firestore";

import { db } from "@/lib/firebase-admin";
import { enrichMediaItems, enrichEpisodeTracking } from "@/lib/tmdb-enrich";

// Force dynamic rendering
export const dynamic = "force-dynamic";

/**
 * POST /api/trakt/enrich
 * Enriches Trakt data with TMDB metadata (posters, ratings, genres)
 *
 * Request body:
 * {
 *   "userId": "firebase_user_id",
 *   "lists": ["already-watched", "watchlist", "favorites"], // optional, defaults to all
 *   "includeEpisodes": true // optional, defaults to false (can be slow)
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { userId, lists, includeEpisodes = false } = body;

    if (!userId) {
      return NextResponse.json(
        { error: "userId is required" },
        { status: 400 },
      );
    }

    // Check if TMDB API key is configured
    if (!process.env.TMDB_API_KEY) {
      return NextResponse.json(
        { error: "TMDB API key not configured" },
        { status: 500 },
      );
    }

    const enrichedCounts = {
      lists: 0,
      items: 0,
      episodes: 0,
    };

    // Default lists to enrich
    const listsToEnrich = lists || [
      "already-watched",
      "watchlist",
      "favorites",
    ];

    // Enrich each list
    for (const listId of listsToEnrich) {
      try {
        const listRef = db
          .collection("users")
          .doc(userId)
          .collection("lists")
          .doc(listId);

        const listDoc = await listRef.get();

        if (!listDoc.exists) {
          console.log(`List ${listId} does not exist, skipping`);
          continue;
        }

        const listData = listDoc.data();

        if (!listData?.items || Object.keys(listData.items).length === 0) {
          console.log(`List ${listId} has no items, skipping`);
          continue;
        }

        console.log(
          `Enriching ${listId} with ${Object.keys(listData.items).length} items...`,
        );

        // Enrich the items
        const enrichedItems = await enrichMediaItems(listData.items);

        // Update the list with enriched data
        await listRef.update({
          items: enrichedItems,
          "metadata.lastEnriched": new Date(),
        });

        enrichedCounts.lists++;
        enrichedCounts.items += Object.keys(enrichedItems).length;

        console.log(`Enriched ${listId} successfully`);
      } catch (error) {
        console.error(`Failed to enrich list ${listId}:`, error);
      }
    }

    // Enrich episode tracking (optional, can be slow for users with lots of episodes)
    if (includeEpisodes) {
      try {
        const episodeTrackingRef = db
          .collection("users")
          .doc(userId)
          .collection("episode_tracking");

        const episodeDocs = await episodeTrackingRef.get();

        for (const doc of episodeDocs.docs) {
          const showId = parseInt(doc.id);
          const episodeData = doc.data();

          if (
            episodeData.episodes &&
            Object.keys(episodeData.episodes).length > 0
          ) {
            console.log(`Enriching episodes for show ${showId}...`);

            const enrichedEpisodes = await enrichEpisodeTracking(
              showId,
              episodeData.episodes,
            );

            // Normalize metadata.lastUpdated if it's a number
            let lastUpdated = episodeData.metadata?.lastUpdated;
            if (typeof lastUpdated === "number") {
              lastUpdated = Timestamp.fromMillis(lastUpdated);
            } else if (typeof lastUpdated === "string") {
              const date = new Date(lastUpdated);
              if (!isNaN(date.getTime())) {
                lastUpdated = Timestamp.fromDate(date);
              }
            }

            await doc.ref.update({
              episodes: enrichedEpisodes,
              "metadata.lastEnriched": Timestamp.now(),
              ...(lastUpdated && { "metadata.lastUpdated": lastUpdated }),
            });

            enrichedCounts.episodes += Object.keys(enrichedEpisodes).length;
          }
        }
      } catch (error) {
        console.error("Failed to enrich episodes:", error);
      }
    }

    return NextResponse.json({
      message: "Enrichment completed",
      userId,
      enriched: enrichedCounts,
    });
  } catch (error) {
    console.error("Error in TMDB enrichment endpoint:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

/**
 * GET /api/trakt/enrich?userId=xxx
 * Check enrichment status
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const userId = searchParams.get("userId");

    if (!userId) {
      return NextResponse.json(
        { error: "userId is required" },
        { status: 400 },
      );
    }

    // Check which lists have been enriched
    const listsStatus: Record<string, any> = {};
    const listIds = ["already-watched", "watchlist", "favorites"];

    for (const listId of listIds) {
      const listDoc = await db
        .collection("users")
        .doc(userId)
        .collection("lists")
        .doc(listId)
        .get();

      if (listDoc.exists) {
        const data = listDoc.data();
        listsStatus[listId] = {
          exists: true,
          itemCount: data?.items ? Object.keys(data.items).length : 0,
          lastEnriched: data?.metadata?.lastEnriched?.toDate().toISOString(),
          hasPosters: data?.items
            ? Object.values(data.items).some((item: any) => item.poster_path)
            : false,
        };
      } else {
        listsStatus[listId] = { exists: false };
      }
    }

    return NextResponse.json({
      userId,
      lists: listsStatus,
    });
  } catch (error) {
    console.error("Error checking enrichment status:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
