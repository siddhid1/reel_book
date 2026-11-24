#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { getDb } from "../db/client.js";
import { creatorRepo, reelRepo } from "../db/repositories.js";
import { normalizeCreator, ManualDiscoveryProvider } from "../discovery/manual.js";
import { InstagramGraphDiscoveryProvider } from "../discovery/graph.js";
import { commitArchive, ensureArchiveRepo } from "../markdown/git.js";
import { runAllOnce, startScheduler } from "../sync/scheduler.js";
import { GeminiFormattingProvider, MockFormattingProvider } from "../formatting/providers.js";
import { GraphMediaProvider, LocalFileMediaProvider, MockMediaProvider, YtDlpMediaProvider } from "../media/provider.js";
import { processPendingReels, reprocessReels } from "../queue/processor.js";
import { syncCreator } from "../sync/service.js";
import { GeminiTranscriptionProvider, LocalWhisperProvider, MockTranscriptionProvider } from "../transcription/providers.js";
import { getTemplatePath, loadConfig } from "../config/settings.js";
import { writeDefaultTemplate } from "../markdown/template.js";

const program = new Command();
program.name("reel-book").description("Instagram Reel transcription & knowledge archive").version("0.1.0");

function ctx() {
  const config = loadConfig();
  const db = getDb(config.databasePath);
  return { config, db };
}

function buildTranscriber(kind: string) {
  if (kind === "mock") return new MockTranscriptionProvider();
  if (kind === "gemini") return new GeminiTranscriptionProvider();
  return new LocalWhisperProvider();
}
function buildFormatter(kind: string) {
  if (kind === "mock") return new MockFormattingProvider();
  return new GeminiFormattingProvider();
}

function readJsonFile<T>(path: string, flag: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err) {
    throw new Error(`Cannot read ${flag} file "${path}": ${(err as Error).message}`);
  }
}

program.command("add-creator <profile>")
  .description("Register a creator (URL, @name, or bare username)")
  .action(async (profile: string) => {
    const { config, db } = ctx();
    void config;
    const { username, profileUrl } = normalizeCreator(profile);
    const row = await creatorRepo.upsert(db, username, profileUrl);
    console.log(`Creator #${row.id}: ${row.username} (${row.profileUrl})`);
  });

program.command("sync <username>")
  .description("Discover new reels (incremental) then process them")
  .option("--reels <file>", "JSON file with reel URLs: {\"urls\": [...], \"meta\": {url: {publishedAt, caption}}}")
  .option("--media-map <file>", "JSON map reel shortcode/URL -> local media file (creator-provided)")
  .option("--transcriber <kind>", "mock|local|gemini", "mock")
  .option("--formatter <kind>", "mock|gemini", "mock")
  .option("--discovery <kind>", "manual|graph", "manual")
  .option("--ig-user-id <id>", "IG-scoped user id (for --discovery graph)")
  .option("--media <kind>", "auto|local|graph|ytdlp|mock (auto: media-map > graph > mock; ytdlp is explicit opt-in only)", "auto")
  .option("--full", "Ignore checkpoint: full historical rescan", false)
  .option("--commit", "Git-commit new markdown docs in the archive", false)
  .action(async (username: string, opts: { reels?: string; mediaMap?: string; transcriber: string; formatter: string; discovery: string; igUserId?: string; media: string; full: boolean; commit: boolean }) => {
    const { config, db } = ctx();
    const norm = normalizeCreator(username);
    const creator = await creatorRepo.upsert(db, norm.username, norm.profileUrl);
    let discovery;
    const igId = opts.igUserId ?? config.graphIgUserId;
    if (opts.discovery === "graph") {
      if (!config.graphAccessToken) throw new Error("GRAPH_ACCESS_TOKEN is not set (see .env.example)");
      discovery = new InstagramGraphDiscoveryProvider(igId, config.graphAccessToken);
    } else {
      const reelsFile = opts.reels ? readJsonFile<{ urls: string[]; meta?: Record<string, { publishedAt?: string; caption?: string }> }>(opts.reels, "--reels") : { urls: [] as string[] };
      const urls: string[] = reelsFile.urls ?? [];
      const meta = reelsFile.meta ?? {};
      discovery = new ManualDiscoveryProvider(urls, meta);
    }
    const overlapDays = opts.full ? 36500 : config.syncOverlapDays; // --full: effectively ignore checkpoint
    const stats = await syncCreator({ db, creatorId: creator.id!, username: creator.username!, discovery, overlapDays });
    console.log(`Discovery: ${stats.discovered} found, ${stats.added} new, ${stats.skipped} already known`);
    const mediaMap = opts.mediaMap ? readJsonFile<Record<string, string>>(opts.mediaMap, "--media-map") : {};
    const mediaKind = opts.media === "auto" ? (Object.keys(mediaMap).length > 0 ? "local" : opts.discovery === "graph" ? "graph" : "mock") : opts.media;
    if (mediaKind === "ytdlp") console.log("NOTE: --media ytdlp downloads outside Instagram's official APIs (opt-in via ALLOW_UNOFFICIAL_DOWNLOAD=1). Use only for content you have the right to archive.");
    const media = mediaKind === "local" ? new LocalFileMediaProvider(mediaMap)
      : mediaKind === "graph" ? new GraphMediaProvider(igId, config.graphAccessToken)
      : mediaKind === "ytdlp" ? new YtDlpMediaProvider()
      : new MockMediaProvider();
    const { processed, failed } = await processPendingReels({
      db, archiveRoot: config.archiveRoot, creatorId: creator.id!, username: creator.username!,
      profileUrl: creator.profileUrl!, media,
      transcriber: buildTranscriber(opts.transcriber),
      formatter: buildFormatter(opts.formatter),
      workDir: "./tmp/work",
      templatePath: getTemplatePath(config),
      onEvent: (m) => console.log(m),
    });
    console.log(`Processing: ${processed} completed, ${failed} failed`);
    if ((opts.commit || config.archiveGitAutocommit) && processed > 0) {
      await ensureArchiveRepo(config.archiveRoot);
      const hash = await commitArchive(config.archiveRoot, `reel-book: @${creator.username} +${processed} reels`);
      if (hash) console.log(`Committed ${hash.slice(0, 8)}`);
      else console.log("Nothing to commit");
    }
  });

program.command("retry <username>")
  .description("Re-run failed/pending reels without re-doing successful stages")
  .option("--media-map <file>", "JSON map reel shortcode/URL -> local media file")
  .option("--transcriber <kind>", "mock|local|gemini", "mock")
  .option("--formatter <kind>", "mock|gemini", "mock")
  .option("--commit", "Git-commit new markdown docs in the archive", false)
  .action(async (username: string, opts: { mediaMap?: string; transcriber: string; formatter: string; commit: boolean }) => {
    const { config, db } = ctx();
    const creator = creatorRepo.getByUsername(db, normalizeCreator(username).username);
    if (!creator?.id) throw new Error("Unknown creator. Run add-creator first.");
    const mediaMap = opts.mediaMap ? readJsonFile<Record<string, string>>(opts.mediaMap, "--media-map") : {};
    const media = Object.keys(mediaMap).length > 0 ? new LocalFileMediaProvider(mediaMap) : new MockMediaProvider();
    const { processed, failed } = await processPendingReels({
      db, archiveRoot: config.archiveRoot, creatorId: creator.id, username: creator.username!,
      profileUrl: creator.profileUrl!, media,
      transcriber: buildTranscriber(opts.transcriber),
      formatter: buildFormatter(opts.formatter),
      workDir: "./tmp/work",
      templatePath: getTemplatePath(config),
      onEvent: (m) => console.log(m),
    });
    console.log(`Retry: ${processed} completed, ${failed} failed`);
    if ((opts.commit || config.archiveGitAutocommit) && processed > 0) {
      await ensureArchiveRepo(config.archiveRoot);
      const hash = await commitArchive(config.archiveRoot, `reel-book: @${creator.username} retry +${processed} reels`);
      if (hash) console.log(`Committed ${hash.slice(0, 8)}`);
    }
  });

program.command("schedule")
  .description("Run incremental sync for ALL creators on an interval (reads inbox files from <archive>/config/discovery/)")
  .option("--interval-min <n>", "Minutes between runs", "60")
  .option("--transcriber <kind>", "mock|local|gemini", "mock")
  .option("--formatter <kind>", "mock|gemini", "mock")
  .option("--commit", "Git-commit new docs after each run", true)
  .option("--once", "Run once for all creators and exit", false)
  .action(async (opts: { intervalMin: string; transcriber: string; formatter: string; commit: boolean; once: boolean }) => {
    const { config, db } = ctx();
    const sopts = {
      intervalMin: Number(opts.intervalMin) || 60,
      transcriber: opts.transcriber,
      formatter: opts.formatter,
      commit: opts.commit,
      runOnce: opts.once,
      onEvent: (m: string) => console.log(new Date().toISOString(), m),
    };
    if (opts.once) {
      await runAllOnce(db, config, sopts);
      return;
    }
    console.log(`Scheduler started: every ${sopts.intervalMin} min. Ctrl+C to stop.`);
    startScheduler(db, config, sopts);
  });

program.command("reset-reel <username> <mediaId>")
  .description("Clear a reel's transcripts + markdown so it can be redone (e.g. redo a mock run with real media)")
  .option("--delete-file", "Also delete the generated markdown file", false)
  .action(async (username: string, mediaId: string, opts: { deleteFile: boolean }) => {
    const { db } = ctx();
    const creator = creatorRepo.getByUsername(db, normalizeCreator(username).username);
    if (!creator?.id) throw new Error("Unknown creator. Run add-creator first.");
    const reel = reelRepo.list(db, creator.id).find((r) => r.instagramMediaId === mediaId);
    if (!reel) throw new Error(`No reel ${mediaId} for @${username}`);
    if (opts.deleteFile && reel.markdownPath) {
      const { unlinkSync, existsSync } = await import("node:fs");
      if (existsSync(reel.markdownPath as string)) unlinkSync(reel.markdownPath as string);
    }
    reelRepo.update(db, reel.id, {
      rawTranscript: null, formattedBody: null, generatedHeading: null,
      markdownPath: null, processingStatus: "QUEUED", lastError: null, retryCount: 0,
    });
    console.log(`Reset ${mediaId} -> QUEUED (raw + formatted + markdown cleared)`);
  });

program.command("reprocess <username>")
  .description("Re-run AI formatting for reels with raw transcripts (e.g. after a prompt change). Never re-transcribes.")
  .option("--formatter <kind>", "mock|gemini", "mock")
  .option("--force", "Reformat even COMPLETED reels", false)
  .option("--limit <n>", "Max reels", "100")
  .option("--commit", "Git-commit updated docs", false)
  .action(async (username: string, opts: { formatter: string; force: boolean; limit: string; commit: boolean }) => {
    const { config, db } = ctx();
    const creator = creatorRepo.getByUsername(db, normalizeCreator(username).username);
    if (!creator?.id) throw new Error("Unknown creator. Run add-creator first.");
    const { reformatted, failed } = await reprocessReels({
      db, creatorId: creator.id, username: creator.username!,
      formatter: buildFormatter(opts.formatter),
      templatePath: getTemplatePath(config),
      force: opts.force, limit: Number(opts.limit) || 100,
      onEvent: (m) => console.log(m),
    });
    console.log(`Reprocess: ${reformatted} reformatted, ${failed} failed`);
    if ((opts.commit || config.archiveGitAutocommit) && reformatted > 0) {
      await ensureArchiveRepo(config.archiveRoot);
      const hash = await commitArchive(config.archiveRoot, `reel-book: @${creator.username} reformat x${reformatted}`);
      if (hash) console.log(`Committed ${hash.slice(0, 8)}`);
    }
  });

program.command("init-template [dest]")
  .description("Write the default configurable markdown template (set ARCHIVE_TEMPLATE_PATH to use it)")
  .action(async (dest?: string) => {
    const { config } = ctx();
    const target = dest ?? `${config.archiveRoot}/config/template.md`;
    writeDefaultTemplate(target);
    console.log(`Template written to ${target}. Set ARCHIVE_TEMPLATE_PATH=${target} in .env to use it.`);
  });

program.command("doctor")
  .description("Check ffmpeg, whisper, Gemini/Graph credentials, archive writability, DB connectivity")
  .action(async () => {
    const { config, db } = ctx();
    const { execFile: ef } = await import("node:child_process");
    const { promisify: pr } = await import("node:util");
    const run = pr(ef);
    const check = async (bin: string) => {
      try { await run(bin, ["-version"]); return "OK"; } catch { return "MISSING"; }
    };
    console.log(`ffmpeg: ${await check("ffmpeg")}`);
    console.log(`whisper-cpp: ${await check(process.env.WHISPER_BIN ?? "whisper-cpp")} (optional; --transcriber local only)`);
    const masked = (v: string) => (v ? `${v.slice(0, 4)}…${v.slice(-4)} (${v.length} chars)` : "NOT SET");
    console.log(`GEMINI_API_KEY: ${masked(config.geminiApiKey)} [format=${config.geminiFormatModel} transcribe=${config.geminiTranscribeModel}]`);
    console.log(`GRAPH_ACCESS_TOKEN: ${config.graphAccessToken ? "SET" : "NOT SET"} GRAPH_IG_USER_ID: ${config.graphIgUserId || "NOT SET"}`);
    try {
      const { mkdirSync, accessSync, constants } = await import("node:fs");
      mkdirSync(config.archiveRoot, { recursive: true });
      accessSync(config.archiveRoot, constants.W_OK);
      console.log(`archiveRoot: OK (${config.archiveRoot})`);
    } catch { console.log(`archiveRoot: NOT WRITABLE (${config.archiveRoot})`); }
    try {
      const n = creatorRepo.list(db).length;
      console.log(`database: OK (${config.databasePath}, ${n} creators)`);
    } catch (e) { console.log(`database: FAIL ${(e as Error).message}`); }
    if (config.geminiApiKey) {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${config.geminiFormatModel}:generateContent?key=${config.geminiApiKey}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: "Reply with exactly: OK" }] }], generationConfig: { temperature: 0, maxOutputTokens: 8 } }),
        });
        console.log(`gemini probe (${config.geminiFormatModel}): HTTP ${res.status}${res.ok ? " OK" : " " + (await res.text()).slice(0, 200)}`);
      } catch (e) { console.log(`gemini probe: FAIL ${(e as Error).message}`); }
    }
  });

program.command("status [username]")
  .description("Show creators + reel processing states")
  .action(async (username?: string) => {
    const { db } = ctx();
    const all = creatorRepo.list(db);
    const rows = username ? all.filter((c) => c.username === normalizeCreator(username).username) : all;
    for (const c of rows) {
      const reels = reelRepo.pendingForCreator(db, c.id!);
      console.log(`${c.username}: sync=${c.syncStatus} lastSuccess=${c.lastSuccessfulSyncAt ?? "-"} lastSeen=${c.lastSeenPublishedAt ?? "-"} pending=${reels.length}`);
      for (const r of reels) console.log(`  - ${r.instagramMediaId} ${r.processingStatus} ${r.lastError ?? ""}`);
    }
  });

program.parseAsync(process.argv);
