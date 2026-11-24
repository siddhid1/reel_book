import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { getDb } from "../db/client.js";
import { creatorRepo } from "../db/repositories.js";
import { normalizeCreator, ManualDiscoveryProvider } from "../discovery/manual.js";
import { InstagramGraphDiscoveryProvider } from "../discovery/graph.js";
import { GeminiFormattingProvider, MockFormattingProvider } from "../formatting/providers.js";
import { OllamaFormattingProvider } from "../formatting/ollama.js";
import { GraphMediaProvider, LocalFileMediaProvider, MockMediaProvider, YtDlpMediaProvider } from "../media/provider.js";
import { commitArchive } from "../markdown/git.js";
import { processPendingReels } from "../queue/processor.js";
import { syncCreator } from "./service.js";
import { GeminiTranscriptionProvider, LocalWhisperProvider, MockTranscriptionProvider } from "../transcription/providers.js";
import { getTemplatePath, type AppConfig } from "../config/settings.js";

export interface ScheduleOptions {
  intervalMin: number;
  transcriber: string;
  formatter: string;
  commit: boolean;
  runOnce: boolean;
  onEvent?: (msg: string) => void;
}

function buildDiscovery(config: AppConfig, username: string) {
  // Per-creator manual inbox: <archiveRoot>/config/discovery/<username>.json
  // { "urls": [...], "meta": {...} }
  const inbox = join(config.archiveRoot, "config", "discovery", `${username}.json`);
  if (existsSync(inbox)) {
    const parsed = JSON.parse(readFileSync(inbox, "utf8")) as {
      urls?: string[]; meta?: Record<string, { publishedAt?: string | null; caption?: string | null }>;
      igUserId?: string;
    };
    if (parsed.igUserId && config.graphAccessToken) {
      return new InstagramGraphDiscoveryProvider(parsed.igUserId, config.graphAccessToken);
    }
    return new ManualDiscoveryProvider(parsed.urls ?? [], parsed.meta ?? {});
  }
  // Global graph fallback: GRAPH_IG_USER_ID + GRAPH_ACCESS_TOKEN
  if (config.graphIgUserId && config.graphAccessToken) {
    return new InstagramGraphDiscoveryProvider(config.graphIgUserId, config.graphAccessToken);
  }
  return new ManualDiscoveryProvider([], {});
}

function buildMedia(config: AppConfig, username: string) {
  const mapFile = join(config.archiveRoot, "config", "media-map", `${username}.json`);
  if (existsSync(mapFile)) {
    const map = JSON.parse(readFileSync(mapFile, "utf8")) as Record<string, string>;
    if (Object.keys(map).length > 0) return new LocalFileMediaProvider(map);
  }
  // Graph inbox (igUserId) or global graph config -> authorized Graph downloads.
  const inbox = join(config.archiveRoot, "config", "discovery", `${username}.json`);
  if (existsSync(inbox)) {
    try {
      const parsed = JSON.parse(readFileSync(inbox, "utf8")) as { igUserId?: string };
      if (parsed.igUserId && config.graphAccessToken) return new GraphMediaProvider(parsed.igUserId, config.graphAccessToken);
    } catch { /* fall through to global/mock */ }
  }
  if (config.graphIgUserId && config.graphAccessToken) return new GraphMediaProvider(config.graphIgUserId, config.graphAccessToken);
  if (config.allowUnofficialDownload) return new YtDlpMediaProvider();
  return new MockMediaProvider();
}

export async function runAllOnce(db: BetterSQLite3Database, config: AppConfig, opts: ScheduleOptions): Promise<void> {
  const creators = creatorRepo.list(db);
  const log = opts.onEvent ?? (() => {});
  if (creators.length === 0) log("scheduler: no creators registered, nothing to do");
  for (const c of creators) {
    const username = c.username!;
    try {
      log(`scheduler: sync @${username}`);
      const discovery = buildDiscovery(config, username);
      const stats = await syncCreator({ db, creatorId: c.id!, username, discovery, overlapDays: config.syncOverlapDays });
      log(`scheduler: @${username} discovery +${stats.added} new / ${stats.discovered} found`);
      const { processed, failed } = await processPendingReels({
        db, archiveRoot: config.archiveRoot, creatorId: c.id!, username,
        profileUrl: c.profileUrl!, media: buildMedia(config, username),
        transcriber: opts.transcriber === "gemini" ? new GeminiTranscriptionProvider() : opts.transcriber === "local" ? new LocalWhisperProvider() : new MockTranscriptionProvider(),
        formatter: opts.formatter === "gemini" ? new GeminiFormattingProvider() : opts.formatter === "ollama" ? new OllamaFormattingProvider() : new MockFormattingProvider(),
        workDir: "./tmp/work",
        templatePath: getTemplatePath(config),
        onEvent: log,
      });
      log(`scheduler: @${username} processed=${processed} failed=${failed}`);
      if (opts.commit && processed > 0) {
        const hash = await commitArchive(config.archiveRoot, `reel-book: @${username} +${processed} reels`);
        if (hash) log(`scheduler: committed ${hash.slice(0, 8)}`);
      }
    } catch (err) {
      // One creator's failure must not stop others.
      log(`scheduler: @${username} ERROR ${(err as Error).message}`);
    }
  }
}

export function startScheduler(db: BetterSQLite3Database, config: AppConfig, opts: ScheduleOptions): NodeJS.Timeout {
  const tick = () => runAllOnce(db, config, opts).catch((e) => opts.onEvent?.(`scheduler tick failed: ${(e as Error).message}`));
  if (opts.runOnce) {
    void tick();
    // Return a dummy handle; caller will exit after pending work settles.
    return setTimeout(() => {}, 0);
  }
  void tick(); // run immediately, then on interval
  return setInterval(tick, Math.max(opts.intervalMin, 1) * 60_000);
}

export function getSchedulerDb(config: AppConfig): BetterSQLite3Database {
  return getDb(config.databasePath);
}
