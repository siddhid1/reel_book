import type { DiscoveryOptions, DiscoveryResult, ReelDiscoveryProvider } from "../providers.js";

interface GraphMediaItem {
  id: string;
  permalink?: string;
  timestamp?: string;
  caption?: string;
  media_type?: string;
}

interface GraphPage {
  data?: GraphMediaItem[];
  paging?: { cursors?: { after?: string }; next?: string };
}

/**
 * Official Instagram Graph API discovery for Business/Creator accounts
 * the user has access to (user access token with instagram_business_basic /
 * instagram_business_manage_insights or Page-connected scopes).
 *
 * Limitations (documented, not worked around):
 * - Cannot enumerate ARBITRARY public creators — only accounts the token
 *   owner can access, plus Business Discovery (subject to permissions/quotas).
 * - Reel filtering is by permalink (/reel/) + media_type VIDEO.
 */
export class InstagramGraphDiscoveryProvider implements ReelDiscoveryProvider {
  readonly name = "instagram-graph";

  constructor(
    private igUserId: string,
    private accessToken: string,
    private fetchFn: typeof fetch = fetch,
  ) {
    if (!igUserId) throw new Error("InstagramGraphDiscoveryProvider: igUserId is required");
    if (!accessToken) throw new Error("InstagramGraphDiscoveryProvider: access token is required (GRAPH_ACCESS_TOKEN)");
  }

  async discoverReels(_username: string, options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const sinceMs = options.since ? Date.parse(options.since) : NaN;
    const out: DiscoveryResult["reels"] = [];
    let after: string | null = options.cursor ?? null;

    for (;;) {
      const params = new URLSearchParams({
        fields: "id,permalink,timestamp,caption,media_type",
        limit: String(limit),
        access_token: this.accessToken,
      });
      if (after) params.set("after", after);
      const url = `https://graph.instagram.com/${this.igUserId}/media?${params}`;
      const res = await this.fetchFn(url);
      if (!res.ok) {
        throw new Error(`Instagram Graph API failed: ${res.status} ${(await res.text()).slice(0, 500)}`);
      }
      const page = (await res.json()) as GraphPage;
      for (const item of page.data ?? []) {
        if (item.media_type && item.media_type !== "VIDEO" && item.media_type !== "REEL") continue;
        if (item.permalink && !item.permalink.includes("/reel/") && !item.permalink.includes("/reels/")) continue;
        if (!Number.isNaN(sinceMs) && item.timestamp && Date.parse(item.timestamp) < sinceMs) continue;
        out.push({
          instagramMediaId: item.id,
          reelUrl: item.permalink ?? `https://www.instagram.com/reel/${item.id}/`,
          publishedAt: item.timestamp ?? null,
          caption: item.caption ?? null,
        });
      }
      after = page.paging?.cursors?.after ?? null;
      if (!after || !page.paging?.next) break;
      if (out.length >= 1000) break; // safety cap per run
    }
    return { reels: out, nextCursor: null };
  }
}

/** Resolve an IG-scoped user id from a username via Business Discovery (requires extra permissions). */
export async function resolveBusinessDiscoveryId(args: {
  myIgUserId: string;
  username: string;
  accessToken: string;
  fetchFn?: typeof fetch;
}): Promise<string> {
  const { myIgUserId, username, accessToken, fetchFn = fetch } = args;
  const params = new URLSearchParams({
    fields: `business_discovery.username(${username}){id}`,
    access_token: accessToken,
  });
  const res = await fetchFn(`https://graph.instagram.com/${myIgUserId}?${params}`);
  if (!res.ok) throw new Error(`Business Discovery failed: ${res.status} ${(await res.text()).slice(0, 500)}`);
  const json = (await res.json()) as { business_discovery?: { id?: string } };
  const id = json.business_discovery?.id;
  if (!id) throw new Error(`Could not resolve @${username} via Business Discovery`);
  return id;
}
