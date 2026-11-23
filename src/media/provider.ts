import { execFile } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { MediaProvider } from "../providers.js";

const execFileAsync = promisify(execFile);

/**
 * LocalFileMediaProvider: creator-provided media files (authorized).
 * Maps reel shortcode -> local video/audio file. No downloading, no scraping.
 */
export class LocalFileMediaProvider implements MediaProvider {
  readonly name = "local-file";
  constructor(private files: Record<string, string> = {}) {}

  async fetchAudio(reelUrl: string, workDir: string) {
    const code = reelUrl.match(/instagram\.com\/(?:reel|p|reels)\/([A-Za-z0-9_-]+)/)?.[1] ?? reelUrl;
    const src = this.files[reelUrl] ?? this.files[code ?? ""];
    if (!src || !existsSync(src)) {
      throw new Error(`No local media registered for ${reelUrl}. Provide creator-authorized file via --media-map.`);
    }
    mkdirSync(workDir, { recursive: true });
    const audioPath = join(workDir, `${code}-audio${extOf(src)}`);
    if (isAudio(src)) return { audioPath: src, cleanup: async () => {} };
    await extractAudio(src, audioPath);
    return { audioPath, cleanup: async () => {} };
  }
}

/** Mock media for offline smoke tests: generates an empty placeholder audio file. */
export class MockMediaProvider implements MediaProvider {
  readonly name = "mock-media";
  async fetchAudio(_reelUrl: string, workDir: string, _mediaId?: string) {
    mkdirSync(workDir, { recursive: true });
    const audioPath = join(workDir, "mock-audio.mp3");
    if (!existsSync(audioPath)) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(audioPath, "mock");
    }
    return { audioPath, cleanup: async () => {} };
  }
}

/**
 * GraphMediaProvider: downloads authorized media via the official Instagram
 * Graph API (`/{media-id}?fields=media_url,media_type`), then extracts audio.
 * Requires the same token/IG id used for Graph discovery. Resolves the API id
 * from the explicit `mediaId` param, falling back to a permalink→id lookup.
 */
export class GraphMediaProvider implements MediaProvider {
  readonly name = "graph";
  constructor(private igUserId: string, private accessToken: string) {
    if (!accessToken) throw new Error("GraphMediaProvider: GRAPH_ACCESS_TOKEN is required");
  }

  async fetchAudio(reelUrl: string, workDir: string, mediaId?: string) {
    mkdirSync(workDir, { recursive: true });
    let apiId = mediaId;
    if (!apiId) {
      const code = reelUrl.match(/instagram\.com\/(?:reel|p|reels)\/([A-Za-z0-9_-]+)/)?.[1];
      if (!code) throw new Error(`GraphMediaProvider: cannot derive media id from ${reelUrl}; pass instagramMediaId`);
      apiId = await this.resolveByShortcode(code);
    }
    const detail = await this.mediaDetail(apiId);
    if (!detail.media_url) throw new Error(`Graph API: no media_url for id ${apiId} (media may be unavailable)`);
    const videoPath = join(workDir, `${apiId}-video${extOfUrl(detail.media_url)}`);
    await downloadToFile(detail.media_url, videoPath);
    if (isAudio(videoPath) || /\.mp3(\?|$)/i.test(detail.media_url)) return { audioPath: videoPath, cleanup: async () => {} };
    const audioPath = join(workDir, `${apiId}-audio.mp3`);
    await extractAudio(videoPath, audioPath);
    return { audioPath, cleanup: async () => {} };
  }

  private async mediaDetail(apiId: string): Promise<{ media_url?: string; media_type?: string }> {
    const params = new URLSearchParams({ fields: "media_url,media_type", access_token: this.accessToken });
    const res = await fetch(`https://graph.instagram.com/${apiId}?${params}`);
    if (!res.ok) throw new Error(`Graph media lookup failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as { media_url?: string; media_type?: string };
  }

  private async resolveByShortcode(code: string): Promise<string> {
    // Business Discovery lookup: permalink shortcode -> media id is not directly
    // exposed, so search recent media. Limited but avoids silent wrong downloads.
    const params = new URLSearchParams({ fields: "id,permalink", limit: "100", access_token: this.accessToken });
    const res = await fetch(`https://graph.instagram.com/${this.igUserId}/media?${params}`);
    if (!res.ok) throw new Error(`Graph media list failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const page = (await res.json()) as { data?: { id: string; permalink?: string }[] };
    const hit = (page.data ?? []).find((m) => m.permalink?.includes(`/${code}/`) || m.permalink?.includes(`/${code}`));
    if (!hit) throw new Error(`GraphMediaProvider: shortcode ${code} not found in recent media; sync via --discovery graph so numeric media IDs are stored`);
    return hit.id;
  }
}

function extOfUrl(u: string): string {
  const m = u.split("?")[0]!.match(/(\.[a-z0-9]+)$/i);
  return m?.[1] ?? ".mp4";
}
function extOf(p: string): string {
  const m = basename(p).match(/(\.[a-z0-9]+)$/i);
  return m?.[1] ?? ".mp3";
}
function isAudio(p: string): boolean {
  return /\.(mp3|wav|m4a|ogg|flac)$/i.test(p);
}

export async function extractAudio(videoPath: string, outPath: string): Promise<string> {
  try {
    await execFileAsync("ffmpeg", ["-y", "-i", videoPath, "-vn", "-acodec", "libmp3lame", "-q:a", "4", outPath]);
    return outPath;
  } catch (err) {
    throw new Error(`ffmpeg failed for ${videoPath}. Install ffmpeg. Cause: ${(err as Error).message}`);
  }
}

/** Download a direct media URL to disk (for authorized direct links only). */
export async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${url}`);
  mkdirSync(join(dest, ".."), { recursive: true });
  const buf = Buffer.from(await res.arrayBuffer());
  const ws = createWriteStream(dest);
  ws.write(buf);
  ws.close();
}
