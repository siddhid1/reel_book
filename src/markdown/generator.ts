import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function slugify(heading: string): string {
  const s = heading.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return s || "untitled";
}

/** Unique, filesystem-safe .md path. Never overwrites: appends -<shortId>, -2, -3. */
export function uniqueMarkdownPath(args: {
  archiveRoot: string; username: string; publishedAt?: string | null;
  heading: string; mediaId: string; existingPaths: Set<string>;
}): string {
  const { archiveRoot, username, publishedAt, heading, mediaId } = args;
  const d = publishedAt ? new Date(publishedAt) : new Date();
  const yyyy = Number.isNaN(d.getTime()) ? "unknown" : String(d.getUTCFullYear());
  const mm = Number.isNaN(d.getTime()) ? "00" : String(d.getUTCMonth() + 1).padStart(2, "0");
  const dir = join(archiveRoot, "creators", sanitize(username), yyyy, mm);
  mkdirSync(dir, { recursive: true });
  const base = slugify(heading);
  const short = mediaId.slice(-6);
  const candidates = [`${base}.md`, `${base}-${short}.md`, `${base}-${short}-2.md`, `${base}-${short}-3.md`];
  let i = 4;
  while (candidates.length < 10) candidates.push(`${base}-${short}-${i++}.md`);
  for (const c of candidates) {
    const full = join(dir, c);
    if (!args.existingPaths.has(full) && !existsSync(full)) return full;
  }
  return join(dir, `${base}-${short}-${Date.now()}.md`);
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64) || "unknown";
}

export interface MarkdownDocInput {
  title: string; creator: string; instagramId: string; reelUrl: string;
  publishedAt?: string | null; processedAt: string;
  body: string; rawTranscript: string;
}

export function renderMarkdown(doc: MarkdownDocInput): string {
  const esc = (v: string) => `"${v.replace(/"/g, '\\"')}"`;
  return [
    "---",
    `title: ${esc(doc.title)}`,
    `creator: ${esc(doc.creator)}`,
    `instagram_id: ${esc(doc.instagramId)}`,
    `reel_url: ${esc(doc.reelUrl)}`,
    `published_at: ${esc(doc.publishedAt ?? "")}`,
    `processed_at: ${esc(doc.processedAt)}`,
    "---",
    "",
    `# ${doc.title}`,
    "",
    doc.body.trim(),
    "",
    "---",
    "",
    "## Original Transcript",
    "",
    (doc.rawTranscript.trim() || "_No speech detected._"),
    "",
  ].join("\n");
}

export function writeMarkdownFile(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  if (existsSync(path)) throw new Error(`Refusing to overwrite existing file: ${path}`);
  writeFileSync(path, content, "utf8");
}
