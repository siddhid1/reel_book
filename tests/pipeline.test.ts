import { describe, expect, it } from "vitest";
import { normalizeCreator, shortcodeFromReelUrl, ManualDiscoveryProvider } from "../src/discovery/manual.js";
import { slugify, uniqueMarkdownPath, renderMarkdown } from "../src/markdown/generator.js";

describe("normalizeCreator", () => {
  it("handles URL, @name, and bare name", () => {
    expect(normalizeCreator("https://www.instagram.com/some.creator/").username).toBe("some.creator");
    expect(normalizeCreator("@some.creator").username).toBe("some.creator");
    expect(normalizeCreator("some.creator").profileUrl).toBe("https://www.instagram.com/some.creator/");
  });
  it("rejects invalid usernames", () => {
    expect(() => normalizeCreator("not a user!!")).toThrow();
  });
});

describe("shortcodeFromReelUrl", () => {
  it("extracts reel codes", () => {
    expect(shortcodeFromReelUrl("https://www.instagram.com/reel/ABC123/")).toBe("ABC123");
    expect(shortcodeFromReelUrl("https://www.instagram.com/p/XYZ_9/")).toBe("XYZ_9");
    expect(shortcodeFromReelUrl("https://www.instagram.com/pranavprakash_3/reel/DgDUhayoqUk/")).toBe("DgDUhayoqUk");
    expect(shortcodeFromReelUrl("https://www.instagram.com/reel/Df7seEPITOl/?cnvx=abc&avpt=def")).toBe("Df7seEPITOl");
    expect(shortcodeFromReelUrl("https://www.instagram.com/pranavprakash_3/?hl=en")).toBeNull();
  });
});

describe("markdown generator", () => {
  it("slugifies headings", () => {
    expect(slugify("Understanding Redis! Caching 101")).toBe("understanding-redis-caching-101");
    expect(slugify("")).toBe("untitled");
  });
  it("avoids collisions without overwriting", () => {
    const existing = new Set<string>();
    const a = uniqueMarkdownPath({ archiveRoot: "/tmp/t1", username: "u", publishedAt: "2026-11-14T10:30:00Z", heading: "Hello", mediaId: "AAA111", existingPaths: existing });
    existing.add(a);
    const b = uniqueMarkdownPath({ archiveRoot: "/tmp/t1", username: "u", publishedAt: "2026-11-14T10:30:00Z", heading: "Hello", mediaId: "BBB222", existingPaths: existing });
    expect(a).not.toBe(b);
    expect(b).toContain("BBB222");
  });
  it("renders traceable frontmatter + raw transcript", () => {
    const md = renderMarkdown({ title: "T", creator: "c", instagramId: "ID1", reelUrl: "https://www.instagram.com/reel/ID1/", publishedAt: "2026-11-14T10:30:00Z", processedAt: "2026-11-18T08:00:00Z", body: "formatted", rawTranscript: "raw words" });
    expect(md).toContain('instagram_id: "ID1"');
    expect(md).toContain("## Original Transcript");
    expect(md).toContain("raw words");
  });
});

describe("ManualDiscoveryProvider", () => {
  it("dedups identity by shortcode and honors since", async () => {
    const p = new ManualDiscoveryProvider(
      ["https://www.instagram.com/reel/A1/", "https://www.instagram.com/reel/B2/"],
      { "https://www.instagram.com/reel/A1/": { publishedAt: "2026-11-10T00:00:00Z" }, "https://www.instagram.com/reel/B2/": { publishedAt: "2026-11-15T00:00:00Z" } },
    );
    const res = await p.discoverReels("u", { since: "2026-11-12T00:00:00Z" });
    expect(res.reels.map((r) => r.instagramMediaId)).toEqual(["B2"]);
  });
});
