import { describe, expect, it } from "vitest";
import { InstagramGraphDiscoveryProvider } from "../src/discovery/graph.js";

function mockFetch(pages: unknown[]) {
  let i = 0;
  return async (_url: string) => ({
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => pages[i++] ?? { data: [] },
  }) as unknown as typeof fetch;
}

describe("InstagramGraphDiscoveryProvider", () => {
  it("maps Graph media to reels, filters non-reels, honors since", async () => {
    const fetchFn = mockFetch([
      {
        data: [
          { id: "1", permalink: "https://www.instagram.com/reel/AAA/", timestamp: "2026-11-13T10:00:00Z", caption: "hi", media_type: "VIDEO" },
          { id: "2", permalink: "https://www.instagram.com/p/PHOTO/", timestamp: "2026-11-14T10:00:00Z", media_type: "IMAGE" },
          { id: "3", permalink: "https://www.instagram.com/reel/BBB/", timestamp: "2026-11-10T10:00:00Z", media_type: "VIDEO" },
        ],
        paging: {},
      },
    ]);
    const p = new InstagramGraphDiscoveryProvider("ME", "TOKEN", fetchFn);
    const res = await p.discoverReels("anyone", { since: "2026-11-12T00:00:00Z" });
    expect(res.reels.map((r) => r.instagramMediaId)).toEqual(["1"]);
    expect(res.reels[0]!.reelUrl).toContain("/reel/AAA/");
  });

  it("requires credentials", () => {
    expect(() => new InstagramGraphDiscoveryProvider("", "T")).toThrow();
    expect(() => new InstagramGraphDiscoveryProvider("ME", "")).toThrow();
  });

  it("surfaces API errors instead of silent empty records", async () => {
    const bad = (async () => ({ ok: false, status: 400, text: async () => "OAuthException", json: async () => ({}) })) as unknown as typeof fetch;
    const p = new InstagramGraphDiscoveryProvider("ME", "BAD", bad);
    await expect(p.discoverReels("x")).rejects.toThrow(/Graph API failed/);
  });
});
