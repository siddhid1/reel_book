import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CreatorMetadata {
  username: string;
  profile_url: string;
  reel_count: number;
  completed_count: number;
  last_successful_sync_at: string | null;
  last_seen_published_at: string | null;
  updated_at: string;
}

/** Per-spec `creators/<username>/metadata.json` — traceability without opening the DB. */
export function writeCreatorMetadata(args: {
  archiveRoot: string;
  username: string;
  profileUrl: string;
  reelCount: number;
  completedCount: number;
  lastSuccessfulSyncAt?: string | null;
  lastSeenPublishedAt?: string | null;
}): string {
  const dir = join(args.archiveRoot, "creators", args.username.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64));
  mkdirSync(dir, { recursive: true });
  const meta: CreatorMetadata = {
    username: args.username,
    profile_url: args.profileUrl,
    reel_count: args.reelCount,
    completed_count: args.completedCount,
    last_successful_sync_at: args.lastSuccessfulSyncAt ?? null,
    last_seen_published_at: args.lastSeenPublishedAt ?? null,
    updated_at: new Date().toISOString(),
  };
  const path = join(dir, "metadata.json");
  writeFileSync(path, JSON.stringify(meta, null, 2) + "\n", "utf8");
  return path;
}
