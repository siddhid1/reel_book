import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb } from "../src/db/client.js";
import { creatorRepo } from "../src/db/repositories.js";
import { runAllOnce } from "../src/sync/scheduler.js";
import { commitArchive } from "../src/markdown/git.js";
import type { AppConfig } from "../src/config/settings.js";

function testConfig(root: string): AppConfig {
  return {
    archiveRoot: root,
    databasePath: join(root, "database", "archive.db"),
    geminiApiKey: "",
    geminiFormatModel: "gemini-3.5-flash",
    geminiTranscribeModel: "gemini-3.5-flash",
    syncOverlapDays: 7,
    graphAccessToken: "",
    graphIgUserId: "",
    archiveGitAutocommit: false,
    archiveTemplatePath: "",
    allowUnofficialDownload: false,
    ytdlpCookiesFile: "",
  };
}

describe("scheduler + git autocommit", () => {
  it("processes inbox files for all creators and commits markdown", async () => {
    const root = mkdtempSync(join(tmpdir(), "reelbook-"));
    const config = testConfig(root);
    const db = getDb(config.databasePath);
    const creator = await creatorRepo.upsert(db, "sched_user", "https://www.instagram.com/sched_user/");
    mkdirSync(join(root, "config", "discovery"), { recursive: true });
    writeFileSync(
      join(root, "config", "discovery", "sched_user.json"),
      JSON.stringify({ urls: ["https://www.instagram.com/reel/ZZZ1/"], meta: { "https://www.instagram.com/reel/ZZZ1/": { publishedAt: "2026-11-17T10:00:00Z" } } }),
    );
    const events: string[] = [];
    await runAllOnce(db, config, { intervalMin: 60, transcriber: "mock", formatter: "mock", commit: true, runOnce: true, onEvent: (m) => events.push(m) });
    expect(events.join("\n")).toContain("processed=1");
    const hash = await commitArchive(root, "test commit");
    // Second commit should be null (nothing new)
    expect(hash).toBeNull();
    expect(creator.id).toBeGreaterThan(0);
  }, 30000);
});
