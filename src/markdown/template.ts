import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MarkdownDocInput } from "./generator.js";
import { renderMarkdown } from "./generator.js";

export type TemplateVars = Record<string, string>;

/**
 * Configurable markdown template. File uses {{token}} placeholders:
 * title, creator, instagram_id, reel_url, published_at, processed_at, body,
 * raw_transcript. When no template path is configured, the built-in format is used.
 */
export function renderWithTemplate(doc: MarkdownDocInput, templatePath?: string | null): string {
  if (!templatePath || !existsSync(templatePath)) return renderMarkdown(doc);
  const tpl = readFileSync(templatePath, "utf8");
  const vars: TemplateVars = {
    title: doc.title,
    creator: doc.creator,
    instagram_id: doc.instagramId,
    reel_url: doc.reelUrl,
    published_at: doc.publishedAt ?? "",
    processed_at: doc.processedAt,
    body: doc.body,
    raw_transcript: doc.rawTranscript,
  };
  return tpl.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, k: string) => vars[k.toLowerCase()] ?? "");
}

const DEFAULT_TEMPLATE = `---
title: "{{title}}"
creator: "{{creator}}"
instagram_id: "{{instagram_id}}"
reel_url: "{{reel_url}}"
published_at: "{{published_at}}"
processed_at: "{{processed_at}}"
---

# {{title}}

{{body}}

---

## Original Transcript

{{raw_transcript}}
`;

export function writeDefaultTemplate(destPath: string): void {
  mkdirSync(join(destPath, ".."), { recursive: true });
  if (!existsSync(destPath)) writeFileSync(destPath, DEFAULT_TEMPLATE, "utf8");
}
