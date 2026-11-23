import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { creators, reels, syncRuns } from "./schema.js";

const now = () => new Date().toISOString();

export const creatorRepo = {
  async upsert(db: BetterSQLite3Database, username: string, profileUrl: string) {
    const existing = await db.select().from(creators).where(eq(creators.username, username)).get();
    if (existing) return existing;
    await db.insert(creators).values({ username, profileUrl, createdAt: now(), syncStatus: "IDLE" }).run();
    const row = await db.select().from(creators).where(eq(creators.username, username)).get();
    if (!row) throw new Error("Failed to create creator");
    return row;
  },
  list(db: BetterSQLite3Database) {
    return db.select().from(creators).all();
  },
  getByUsername(db: BetterSQLite3Database, username: string) {
    return db.select().from(creators).where(eq(creators.username, username)).get();
  },
  updateSync(db: BetterSQLite3Database, id: number, patch: Partial<{ lastSyncAttemptAt: string | null; lastSuccessfulSyncAt: string | null; lastSeenPublishedAt: string | null; syncStatus: string }>) {
    return db.update(creators).set(patch).where(eq(creators.id, id)).run();
  },
};

export interface DiscoveredReelInput {
  instagramMediaId: string;
  reelUrl: string;
  publishedAt?: string | null;
  caption?: string | null;
}

export const reelRepo = {
  /** INSERT OR IGNORE semantics: returns true if newly inserted. Dedup key = instagram_media_id. */
  insertIfNew(db: BetterSQLite3Database, creatorId: number, r: DiscoveredReelInput): boolean {
    const res = db
      .insert(reels)
      .values({
        creatorId,
        instagramMediaId: r.instagramMediaId,
        reelUrl: r.reelUrl,
        publishedAt: r.publishedAt ?? null,
        caption: r.caption ?? null,
        processingStatus: "QUEUED",
        createdAt: now(),
        updatedAt: now(),
      })
      .onConflictDoNothing({ target: reels.instagramMediaId })
      .run();
    return Number(res.changes ?? 0) > 0;
  },
  list(db: BetterSQLite3Database, creatorId?: number) {
    if (creatorId == null) return db.select().from(reels).all();
    return db.select().from(reels).where(eq(reels.creatorId, creatorId)).all();
  },
  pendingForCreator(db: BetterSQLite3Database, creatorId: number) {
    return db.select().from(reels).where(eq(reels.creatorId, creatorId)).all()
      .filter((r) => r.processingStatus !== "COMPLETED" && r.processingStatus !== "UNAVAILABLE");
  },
  get(db: BetterSQLite3Database, id: number) {
    return db.select().from(reels).where(eq(reels.id, id)).get();
  },
  update(db: BetterSQLite3Database, id: number, patch: Record<string, unknown>) {
    return db.update(reels).set({ ...patch, updatedAt: now() }).where(eq(reels.id, id)).run();
  },
};

export const syncRunRepo = {
  async start(db: BetterSQLite3Database, creatorId: number) {
    await db.insert(syncRuns).values({ creatorId, startedAt: now(), status: "RUNNING" }).run();
    const rows = db.select().from(syncRuns).all();
    return rows[rows.length - 1]!;
  },
  finish(db: BetterSQLite3Database, id: number, patch: Record<string, unknown>) {
    return db.update(syncRuns).set({ ...patch, completedAt: now() }).where(eq(syncRuns.id, id)).run();
  },
};
