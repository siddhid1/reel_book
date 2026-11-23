import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb } from "../src/db/client.js";
import { creatorRepo, reelRepo } from "../src/db/repositories.js";
import { syncCreator } from "../src/sync/service.js";
import { reprocessReels } from "../src/queue/processor.js";
import { MockFormattingProvider } from "../src/formatting/providers.js";
import { renderWithTemplate, writeDefaultTemplate } from "../src/markdown/template.js";
import { writeCreatorMetadata } from "../src/creator/metadata.js";
import { fetchWithRetry } from "../src/utils/retry.js";
import type { ReelDiscoveryProvider } from "../src/providers.js";

describe("interrupted discovery does not advance checkpoint", () => {
  it("leaves lastSuccessfulSyncAt untouched and marks sync FAILED", async () => {
    const root = mkdtempSync(join(tmpdir(), "reelbook-sync-"));
    const db = getDb(join(root, "archive.db"));
    const creator = await creatorRepo.upsert(db, "interrupt_user", "https://www.instagram.com/interrupt_user/");
    // Seed a successful checkpoint
    const { creatorRepo: cr } = await import("../src/db/repositories.js");
    cr.updateSync(db, creator.id!, { lastSuccessfulSyncAt: "2026-11-12T00:00:00Z", lastSeenPublishedAt: "2026-11-12T00:00:00Z", syncStatus: "SUCCEEDED" });

    let calls = 0;
    const flaky: ReelDiscoveryProvider = {
      name: "flaky",
      async discoverReels() {
        calls++;
        if (calls === 1) {
          return {
            reels: [{ instagramMediaId: "P1", reelUrl: "https://www.instagram.com/reel/P1/", publishedAt: "2026-11-14T00:00:00Z" }],
            nextCursor: "page2",
          };
        }
        throw new Error("network down mid-pagination");
      },
    };
    await expect(syncCreator({ db, creatorId: creator.id!, username: "interrupt_user", discovery: flaky, overlapDays: 7 })).rejects.toThrow(/network down/);
    const { eq } = await import("drizzle-orm");
    const { creators } = await import("../src/db/client.js");
    const row = db.select().from(creators).where(eq(creators.id, creator.id!)).get()!;
    expect(row.lastSuccessfulSyncAt).toBe("2026-11-12T00:00:00Z"); // NOT advanced
    expect(row.syncStatus).toBe("FAILED");
    expect(calls).toBe(2);
  });
});

describe("reprocess resumes from formatting (no re-transcribe)", () => {
  it("reformats raw transcripts and updates markdown in place", async () => {
    const root = mkdtempSync(join(tmpdir(), "reelbook-re-"));
    const db = getDb(join(root, "archive.db"));
    const creator = await creatorRepo.upsert(db, "re_user", "https://www.instagram.com/re_user/");
    reelRepo.insertIfNew(db, creator.id!, { instagramMediaId: "R1", reelUrl: "https://www.instagram.com/reel/R1/" });
    const reel = reelRepo.list(db, creator.id!).find((r) => r.instagramMediaId === "R1")!;
    reelRepo.update(db, reel.id, { rawTranscript: "old words here", processingStatus: "FAILED_FORMATTING" });
    const { reformatted, failed } = await reprocessReels({
      db, creatorId: creator.id!, username: "re_user",
      formatter: new MockFormattingProvider(), force: false,
    });
    expect(reformatted).toBe(1);
    expect(failed).toBe(0);
    const after = reelRepo.get(db, reel.id)!;
    expect(after.formattedBody).toContain("old words here");
    expect(after.processingStatus).toBe("QUEUED"); // no md yet -> back to queue for markdown stage
  });
});

describe("configurable template + metadata sidecar", () => {
  it("renders {{tokens}} and falls back without a template", () => {
    const doc = { title: "T", creator: "c", instagramId: "ID", reelUrl: "u", publishedAt: "p", processedAt: "now", body: "B", rawTranscript: "R" };
    expect(renderWithTemplate(doc, "/nonexistent/t.md")).toContain('title: "T"');
    const dir = mkdtempSync(join(tmpdir(), "reelbook-tpl-"));
    const tpl = join(dir, "t.md");
    writeDefaultTemplate(tpl);
    writeFileSync(tpl, "# {{title}} by {{creator}} :: {{body}}", "utf8");
    expect(renderWithTemplate(doc, tpl)).toBe("# T by c :: B");
  });

  it("writes creators/<user>/metadata.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "reelbook-meta-"));
    const p = writeCreatorMetadata({ archiveRoot: dir, username: "u1", profileUrl: "https://www.instagram.com/u1/", reelCount: 3, completedCount: 2, lastSuccessfulSyncAt: "s", lastSeenPublishedAt: "p" });
    expect(p.endsWith("metadata.json")).toBe(true);
  });
});

describe("fetchWithRetry", () => {
  it("retries 503 then succeeds; throws immediately on 400", async () => {
    const orig = globalThis.fetch;
    let n = 0;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
      n++;
      if (n === 1) return new Response("busy", { status: 503 });
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const res = await fetchWithRetry("http://x", {}, { baseDelayMs: 1 });
      expect(res.status).toBe(200);
      expect(n).toBe(2);
    } finally {
      globalThis.fetch = orig;
    }
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => new Response("bad", { status: 400 })) as unknown as typeof fetch;
    try {
      await expect(fetchWithRetry("http://x", {}, { baseDelayMs: 1 })).rejects.toThrow(/400/);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
