import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { creatorRepo, reelRepo, syncRunRepo } from "../db/repositories.js";
import type { ReelDiscoveryProvider } from "../providers.js";

export interface SyncStats {
  discovered: number;
  added: number;
  skipped: number;
}

/**
 * Incremental sync with overlap window + ID dedup.
 * Checkpoint (lastSuccessfulSyncAt) advances ONLY on full discovery success.
 */
export async function syncCreator(args: {
  db: BetterSQLite3Database;
  creatorId: number;
  username: string;
  discovery: ReelDiscoveryProvider;
  overlapDays: number;
}): Promise<SyncStats> {
  const { db, creatorId, username, discovery, overlapDays } = args;
  const run = await syncRunRepo.start(db, creatorId);
  await creatorRepo.updateSync(db, creatorId, {
    lastSyncAttemptAt: new Date().toISOString(),
    syncStatus: "RUNNING",
  });

  try {
    const creators = (await import("../db/client.js")).creators;
    const { eq } = await import("drizzle-orm");
    const row = db.select().from(creators).where(eq(creators.id, creatorId)).get();
    const lastSeen = row?.lastSeenPublishedAt ? Date.parse(row.lastSeenPublishedAt) : NaN;
    const since = !Number.isNaN(lastSeen)
      ? new Date(lastSeen - overlapDays * 86400_000).toISOString()
      : null;

    // Paginated discovery (provider may return cursor; loop until exhausted)
    let cursor: string | null | undefined = undefined;
    let discovered = 0;
    let added = 0;
    let maxPublished: string | null = row?.lastSeenPublishedAt ?? null;
    do {
      const res = await discovery.discoverReels(username, { since, cursor: cursor ?? null });
      for (const r of res.reels) {
        discovered++;
        const isNew = reelRepo.insertIfNew(db, creatorId, {
          instagramMediaId: r.instagramMediaId,
          reelUrl: r.reelUrl,
          publishedAt: r.publishedAt ?? null,
          caption: r.caption ?? null,
        });
        if (isNew) added++;
        if (r.publishedAt && (!maxPublished || r.publishedAt > maxPublished)) maxPublished = r.publishedAt;
      }
      cursor = res.nextCursor ?? null;
      await syncRunRepo.finish(db, run.id!, { status: "RUNNING", reelsDiscovered: discovered, reelsNew: added, cursorState: cursor });
    } while (cursor);

    await syncRunRepo.finish(db, run.id!, { status: "SUCCEEDED", reelsDiscovered: discovered, reelsNew: added });
    await creatorRepo.updateSync(db, creatorId, {
      lastSuccessfulSyncAt: new Date().toISOString(),
      lastSeenPublishedAt: maxPublished,
      syncStatus: "SUCCEEDED",
    });
    return { discovered, added, skipped: discovered - added };
  } catch (err) {
    const msg = (err as Error).message;
    await syncRunRepo.finish(db, run.id!, { status: "FAILED", errorMessage: msg });
    await creatorRepo.updateSync(db, creatorId, { syncStatus: "FAILED" });
    throw err;
  }
}
