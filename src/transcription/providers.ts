import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "../config/settings.js";
import type { TranscriptionProvider } from "../providers.js";
import { fetchWithRetry, logGeminiCall } from "../utils/retry.js";

const execFileAsync = promisify(execFile);

/** Local Whisper via `whisper.cpp` main binary or `faster-whisper` python CLI. Free, offline. */
export class LocalWhisperProvider implements TranscriptionProvider {
  readonly name = "local-whisper";
  constructor(private binary = process.env.WHISPER_BIN ?? "whisper-cpp", private model = process.env.WHISPER_MODEL ?? "base") {}

  async transcribe(input: { audioPath: string }) {
    try {
      const { stdout } = await execFileAsync(this.binary, ["-m", this.model, "-f", input.audioPath, "-otxt", "-of", "-"]);
      return { text: stdout.trim() };
    } catch (err) {
      throw new Error(`Local Whisper failed (${this.binary}). Install whisper.cpp or use --transcriber gemini. Cause: ${(err as Error).message}`);
    }
  }
}

/**
 * Gemini audio transcription: multimodal model returns VERBATIM transcript.
 * Prompt is deliberately strict to avoid summarization/hallucination.
 */
export class GeminiTranscriptionProvider implements TranscriptionProvider {
  readonly name = "gemini";
  constructor(private apiKey = loadConfig().geminiApiKey, private model = loadConfig().geminiTranscribeModel) {}

  async transcribe(input: { audioPath: string; mimeType?: string }) {
    if (!this.apiKey) throw new Error("GEMINI_API_KEY is not set. See .env.example.");
    const { readFile } = await import("node:fs/promises");
    const buf = await readFile(input.audioPath);
    if (buf.length > 20 * 1024 * 1024) {
      throw new Error("Audio file >20MB inline limit for Gemini inlineData. Compress or use local Whisper.");
    }
    const mimeType = input.mimeType ?? guessMime(input.audioPath);
    const startedAt = Date.now();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
    const res = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          generationConfig: { temperature: 0, responseMimeType: "text/plain" },
          contents: [
            {
              parts: [
                { text: "Transcribe this audio VERBATIM. Output only the spoken words with punctuation. Do not summarize, translate, or add commentary. If there is no speech, output an empty string." },
                { inlineData: { mimeType, data: buf.toString("base64") } },
              ],
            },
          ],
        }),
      },
      { onRetry: (a, s, d) => console.error(`gemini transcribe retry ${a} (HTTP ${s}) in ${d}ms`) },
    );
    logGeminiCall({ model: this.model, operation: "transcribe", startedAt, audioBytes: buf.length });
    const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    return { text: text.trim() };
  }
}

function guessMime(p: string): string {
  if (/\.wav$/i.test(p)) return "audio/wav";
  if (/\.m4a$/i.test(p)) return "audio/mp4";
  if (/\.ogg$/i.test(p)) return "audio/ogg";
  return "audio/mp3";
}

/** Deterministic mock for tests / offline runs. */
export class MockTranscriptionProvider implements TranscriptionProvider {
  readonly name = "mock";
  async transcribe() {
    return { text: "Hello world. This is a test transcript about Redis caching." };
  }
}
