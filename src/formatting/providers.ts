import { loadConfig } from "../config/settings.js";
import type { FormattedContent, FormattingProvider } from "../providers.js";
import { fetchWithRetry, logGeminiCall } from "../utils/retry.js";

const SYSTEM_PROMPT = `You clean up raw speech transcripts for a personal knowledge archive.
Rules:
- Preserve original meaning and all facts, names, numbers, technical terms.
- Fix punctuation and obvious ASR errors, split into logical paragraphs.
- Add short markdown section headings ONLY where the content clearly shifts topic.
- Generate a concise descriptive heading (<= 80 chars, no clickbait).
- NEVER invent facts, never summarize away detail, never add a "Key Takeaways" section unless the speaker gave one.
- Output valid JSON: {"heading": string, "markdownBody": string}. markdownBody is markdown (paragraphs + ## headings), no frontmatter.
- If transcript is empty/gibberish, heading must be "Untitled Reel" and body the raw text as-is.`;

/** Gemini structured-output formatter. */
export class GeminiFormattingProvider implements FormattingProvider {
  readonly name = "gemini-format";
  constructor(private apiKey = loadConfig().geminiApiKey, private model = loadConfig().geminiFormatModel) {}

  async format(input: { rawTranscript: string; caption?: string | null }): Promise<FormattedContent> {
    if (!this.apiKey) throw new Error("GEMINI_API_KEY is not set. See .env.example.");
    if (!input.rawTranscript.trim()) return { heading: "Untitled Reel", markdownBody: input.rawTranscript };
    const startedAt = Date.now();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
    const res = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
          contents: [{ parts: [{ text: `Caption: ${input.caption ?? "(none)"}\n\nTranscript:\n${input.rawTranscript}` }] }],
        }),
      },
      { onRetry: (a, s, d) => console.error(`gemini format retry ${a} (HTTP ${s}) in ${d}ms`) },
    );
    logGeminiCall({ model: this.model, operation: "format", startedAt, inputChars: input.rawTranscript.length });
    const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const raw = (json.candidates?.[0]?.content?.parts ?? []).map((p) => ("text" in p && typeof p.text === "string" ? p.text : "")).join("") || "{}";
    const parsed = parseJsonObject(raw) as Partial<FormattedContent>;
    const heading = (parsed.heading ?? "Untitled Reel").slice(0, 120) || "Untitled Reel";
    const markdownBody = parsed.markdownBody ?? input.rawTranscript;
    return { heading, markdownBody };
  }
}

/** Extract the first {...} JSON object (models sometimes wrap it in prose) then parse. */
function parseJsonObject(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  const slice = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
  return JSON.parse(slice);
}

/** Deterministic mock for tests / offline runs. */
export class MockFormattingProvider implements FormattingProvider {
  readonly name = "mock-format";
  async format(input: { rawTranscript: string }): Promise<FormattedContent> {
    const first = input.rawTranscript.split(".")[0]?.slice(0, 60) ?? "Untitled Reel";
    return { heading: first.trim() || "Untitled Reel", markdownBody: input.rawTranscript.trim() + "\n" };
  }
}
