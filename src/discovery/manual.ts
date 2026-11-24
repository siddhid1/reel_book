import type { DiscoveryOptions, DiscoveryResult, ReelDiscoveryProvider } from "../providers.js";

/**
 * Normalize user input ("@user", full URL, bare name) to a canonical username + profile URL.
 * Throws on invalid input.
 */
export function normalizeCreator(input: string): { username: string; profileUrl: string } {
  let s = input.trim().replace(/^@/, "");
  const m = s.match(/(?:instagram\.com\/)([A-Za-z0-9._]+)/i);
  if (m?.[1]) s = m[1];
  s = s.replace(/\/+$/, "");
  if (!/^[A-Za-z0-9._]{1,30}$/.test(s)) {
    throw new Error(`Invalid Instagram username: "${input}"`);
  }
  return { username: s, profileUrl: `https://www.instagram.com/${s}/` };
}

/** Extract media shortcode from /reel/<CODE>/, /<user>/reel/<CODE>/, or /p/<CODE>/ URLs. */
export function shortcodeFromReelUrl(url: string): string | null {
  const m = url.match(/\/(?:reel|p|reels)\/([A-Za-z0-9_-]+)/);
  return m?.[1] ?? null;
}

/**
 * ManualDiscoveryProvider (M2 v1).
 * The user supplies reel URLs (creator-provided / authorized). No scraping.
 * Supports incremental sync via `since` + dedup happens in the DB layer.
 */
export class ManualDiscoveryProvider implements ReelDiscoveryProvider {
  readonly name = "manual";
  private urls: string[];
  private meta: Map<string, { publishedAt?: string | null; caption?: string | null }>;

  constructor(urls: string[] = [], meta: Record<string, { publishedAt?: string | null; caption?: string | null }> = {}) {
    this.urls = urls;
    this.meta = new Map(Object.entries(meta));
  }

  async discoverReels(_username: string, options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
    const since = options.since ? Date.parse(options.since) : NaN;
    const out: DiscoveryResult["reels"] = [];
    for (const url of this.urls) {
      const code = shortcodeFromReelUrl(url);
      if (!code) continue;
      const extra = this.meta.get(url) ?? this.meta.get(code) ?? {};
      if (!Number.isNaN(since) && extra.publishedAt) {
        if (Date.parse(extra.publishedAt) < since) continue;
      }
      out.push({
        instagramMediaId: code,
        reelUrl: url.includes("instagram.com") ? url : `https://www.instagram.com/reel/${code}/`,
        publishedAt: extra.publishedAt ?? null,
        caption: extra.caption ?? null,
      });
    }
    return { reels: out, nextCursor: null };
  }
}
