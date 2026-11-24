import type { FormattedContent, FormattingProvider } from "../providers.js";

const SYSTEM_PROMPT = `You clean up raw speech transcripts for a personal knowledge archive.
Rules:
- Preserve original meaning and all facts, names, numbers, technical terms.
- Fix punctuation and obvious ASR errors, split into logical paragraphs.
- Add short markdown section headings ONLY where the content clearly shifts topic.
- Generate a concise descriptive heading (80 chars max, no clickbait).
- NEVER invent facts, never summarize away detail, never add a "Key Takeaways" section unless the speaker gave one.
- Output ONLY valid JSON with exactly these keys: {"heading": string, "markdownBody": string}. markdownBody is markdown (paragraphs + ## headings), no frontmatter.
- If transcript is empty/gibberish, heading must be "Untitled Reel" and body the raw text as-is.`;

/**
 * OllamaFormattingProvider — local LLM formatting. Free, offline, no quotas.
 * Requires `ollama serve` running and the model pulled (e.g. `ollama pull qwen2.5:7b-instruct`).
 */
export class OllamaFormattingProvider implements FormattingProvider {
  readonly name = "ollama-format";
  constructor(
    private model = process.env.OLLAMA_FORMAT_MODEL ?? "qwen2.5:7b-instruct",
    private baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
  ) {}

  async format(input: { rawTranscript: string; caption?: string | null }): Promise<FormattedContent> {
    if (!input.rawTranscript.trim()) return { heading: "Untitled Reel", markdownBody: input.rawTranscript };
    const startedAt = Date.now();
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          system: SYSTEM_PROMPT,
          prompt: `Caption: ${input.caption ?? "(none)"}\n\nTranscript:\n${input.rawTranscript}`,
          stream: false,
          format: "json",
          options: { temperature: 0.2, num_ctx: 8192 },
        }),
        signal: AbortSignal.timeout(300_000),
      });
    } catch (err) {
      throw new Error(`Ollama not reachable at ${this.baseUrl} (is 'ollama serve' running?). Cause: ${(err as Error).message}`);
    }
    if (!res.ok) throw new Error(`Ollama format failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { response?: string };
    const ms = Date.now() - startedAt;
    console.error(`ollama format model=${this.model} ${ms}ms inputChars=${input.rawTranscript.length}`);
    const parsed = parseJsonObject(json.response ?? "{}") as Partial<FormattedContent>;
    const heading = (parsed.heading ?? "Untitled Reel").slice(0, 120) || "Untitled Reel";
    return { heading, markdownBody: parsed.markdownBody ?? input.rawTranscript };
  }
}

/** Extract the first {...} JSON object (models sometimes wrap it in prose) then parse. */
function parseJsonObject(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  const slice = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
  return JSON.parse(slice);
}
