import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { getDb } from "../db/client.js";
import { creatorRepo, reelRepo } from "../db/repositories.js";
import { uniqueMarkdownPath, writeMarkdownFile } from "../markdown/generator.js";
import { renderWithTemplate } from "../markdown/template.js";
import { writeCreatorMetadata } from "../creator/metadata.js";
import type { FormattingProvider, MediaProvider, TranscriptionProvider } from "../providers.js";

/**
 * Restartable, idempotent per-reel pipeline:
 * QUEUED -> TRANSCRIBING (persist raw) -> FORMATTING (persist formatted) -> COMPLETED (write md).
 * Retries resume from the first missing artifact; failures never block other reels.
 */
export async function processPendingReels(args: {
  db: BetterSQLite3Database;
  archiveRoot: string;
  creatorId: number;
  username: string;
  profileUrl?: string;
  media: MediaProvider;
  transcriber: TranscriptionProvider;
  formatter: FormattingProvider;
  workDir: string;
  templatePath?: string | null;
  onEvent?: (msg: string) => void;
}): Promise<{ processed: number; failed: number }> {
  const { db, archiveRoot, creatorId, username, profileUrl, media, transcriber, formatter, workDir, templatePath, onEvent } = args;
  const pending = reelRepo.pendingForCreator(db, creatorId);
  let processed = 0;
  let failed = 0;

  for (const reel of pending) {
    const log = (m: string) => onEvent?.(`[reel ${reel.instagramMediaId}] ${m}`);
    try {
      // Stage 1-2: media/audio (skip if we already have raw transcript)
      let raw = reel.rawTranscript as string | null;
      if (!raw) {
        reelRepo.update(db, reel.id, { processingStatus: "TRANSCRIBING", lastError: null });
        log(`fetching media via ${media.name}`);
        const { audioPath, cleanup } = await media.fetchAudio(reel.reelUrl, workDir, reel.instagramMediaId);
        try {
          log(`transcribing via ${transcriber.name}`);
          const res = await transcriber.transcribe({ audioPath });
          raw = res.text ?? "";
        } finally {
          await cleanup().catch(() => {});
        }
        reelRepo.update(db, reel.id, { rawTranscript: raw, processingStatus: "FORMATTING" });
      }

      // Stage 3: AI formatting (skip if already formatted)
      let heading = reel.generatedHeading as string | null;
      let body = reel.formattedBody as string | null;
      if (!heading || !body) {
        reelRepo.update(db, reel.id, { processingStatus: "FORMATTING", lastError: null });
        log(`formatting via ${formatter.name}`);
        try {
          const f = await formatter.format({ rawTranscript: raw ?? "", caption: reel.caption });
          heading = f.heading;
          body = f.markdownBody;
        } catch (err) {
          reelRepo.update(db, reel.id, {
            processingStatus: "FAILED_FORMATTING",
            lastError: String((err as Error).message).slice(0, 2000),
            retryCount: (reel.retryCount ?? 0) + 1,
          });
          failed++;
          continue; // raw transcript is persisted; next run resumes from formatting
        }
        reelRepo.update(db, reel.id, { generatedHeading: heading, formattedBody: body });
      }

      // Stage 4: markdown (skip if already written)
      if (!reel.markdownPath) {
        try {
          // All known paths for this creator (not just pending) + filesystem check inside.
          const existing = new Set(
            reelRepo.list(db, creatorId).map((r) => r.markdownPath).filter(Boolean) as string[],
          );
          const mdPath = uniqueMarkdownPath({
            archiveRoot, username,
            publishedAt: reel.publishedAt, heading: heading ?? "Untitled Reel",
            mediaId: reel.instagramMediaId, existingPaths: existing,
          });
          const md = renderWithTemplate({
            title: heading ?? "Untitled Reel",
            creator: username,
            instagramId: reel.instagramMediaId,
            reelUrl: reel.reelUrl,
            publishedAt: reel.publishedAt,
            processedAt: new Date().toISOString(),
            body: body ?? raw ?? "",
            rawTranscript: raw ?? "",
          }, templatePath);
          writeMarkdownFile(mdPath, md);
          reelRepo.update(db, reel.id, { markdownPath: mdPath, processingStatus: "COMPLETED", lastError: null });
        } catch (err) {
          reelRepo.update(db, reel.id, {
            processingStatus: "FAILED_MARKDOWN",
            lastError: String((err as Error).message).slice(0, 2000),
          });
          failed++;
          continue;
        }
      } else {
        reelRepo.update(db, reel.id, { processingStatus: "COMPLETED", lastError: null });
      }
      processed++;
      log("completed");
    } catch (err) {
      const msg = String((err as Error).message).slice(0, 2000);
      const status = reel.rawTranscript ? "FAILED_FORMATTING" : "FAILED_TRANSCRIPTION";
      reelRepo.update(db, reel.id, { processingStatus: status, lastError: msg, retryCount: (reel.retryCount ?? 0) + 1 });
      log(`failed: ${msg}`);
      failed++;
    }
  }
  // Per-spec creator metadata sidecar (traceability without opening the DB).
  try {
    const all = reelRepo.list(db, creatorId);
    const done = all.filter((r) => r.processingStatus === "COMPLETED").length;
    const creator = creatorRepo.getByUsername(db, username) ?? creatorRepo.list(db).find((c) => c.id === creatorId);
    writeCreatorMetadata({
      archiveRoot, username,
      profileUrl: profileUrl ?? creator?.profileUrl ?? `https://www.instagram.com/${username}/`,
      reelCount: all.length, completedCount: done,
      lastSuccessfulSyncAt: creator?.lastSuccessfulSyncAt ?? null,
      lastSeenPublishedAt: creator?.lastSeenPublishedAt ?? null,
    });
  } catch {
    // metadata sidecar must never fail the run
  }
  return { processed, failed };
}

/**
 * Reprocess: re-run AI formatting (+ regenerate markdown in place) for reels
 * that already have a raw transcript. Used when the formatting prompt changes.
 * Never re-transcribes. Updates the EXISTING markdown file in place.
 */
export async function reprocessReels(args: {
  db: BetterSQLite3Database;
  creatorId: number;
  username: string;
  formatter: FormattingProvider;
  templatePath?: string | null;
  force?: boolean;
  limit?: number;
  onEvent?: (msg: string) => void;
}): Promise<{ reformatted: number; failed: number }> {
  const { db, creatorId, username, formatter, templatePath, force, limit, onEvent } = args;
  const candidates = reelRepo.list(db, creatorId).filter((r) => r.rawTranscript && (force || !r.formattedBody || !r.generatedHeading || r.processingStatus === "FAILED_FORMATTING"));
  let reformatted = 0;
  let failed = 0;
  for (const reel of candidates.slice(0, limit ?? 1000)) {
    try {
      onEvent?.(`[reel ${reel.instagramMediaId}] reformatting via ${formatter.name}`);
      const f = await formatter.format({ rawTranscript: (reel.rawTranscript as string) ?? "", caption: reel.caption });
      reelRepo.update(db, reel.id, { generatedHeading: f.heading, formattedBody: f.markdownBody, processingStatus: reel.markdownPath ? "COMPLETED" : "QUEUED", lastError: null });
      if (reel.markdownPath) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(
          reel.markdownPath as string,
          renderWithTemplate({
            title: f.heading, creator: username, instagramId: reel.instagramMediaId,
            reelUrl: reel.reelUrl, publishedAt: reel.publishedAt,
            processedAt: new Date().toISOString(), body: f.markdownBody, rawTranscript: (reel.rawTranscript as string) ?? "",
          }, templatePath),
          "utf8",
        );
      }
      reformatted++;
    } catch (err) {
      reelRepo.update(db, reel.id, { processingStatus: "FAILED_FORMATTING", lastError: String((err as Error).message).slice(0, 2000) });
      failed++;
    }
  }
  return { reformatted, failed };
}

export function getDbFor(config: { databasePath: string }) {
  return getDb(config.databasePath);
}
