/** Exponential backoff for transient Gemini/API failures. Retries 429 + 5xx only. */

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  onRetry?: (attempt: number, status: number, delayMs: number) => void;
}

const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function fetchWithRetry(url: string, init: RequestInit, opts: RetryOptions = {}): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 2000;
  let lastRes: Response | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
    } catch (err) {
      // Network hang / DNS failure: retryable until attempts run out.
      if (attempt === maxAttempts) throw new Error(`API request failed (network): ${(err as Error).message}`);
      const delay = baseDelayMs * 2 ** (attempt - 1) + Math.random() * 500;
      opts.onRetry?.(attempt, 0, Math.round(delay));
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    if (res.ok) return res;
    lastRes = res;
    const retryable = TRANSIENT.has(res.status);
    if (!retryable || attempt === maxAttempts) {
      const body = (await res.text()).slice(0, 500);
      throw new Error(`API request failed: ${res.status} ${body}`);
    }
    const retryAfter = Number(res.headers.get("retry-after") ?? "0") * 1000;
    const delay = retryAfter > 0 ? retryAfter : baseDelayMs * 2 ** (attempt - 1) + Math.random() * 500;
    opts.onRetry?.(attempt, res.status, Math.round(delay));
    await new Promise((r) => setTimeout(r, delay));
  }
  // Unreachable, but satisfies TS.
  return lastRes!;
}

/** Minimal cost/usage log line for every Gemini call. */
export function logGeminiCall(args: {
  onEvent?: (msg: string) => void;
  model: string;
  operation: "transcribe" | "format";
  startedAt: number;
  audioBytes?: number;
  inputChars?: number;
}): void {
  const ms = Date.now() - args.startedAt;
  const extra = args.audioBytes != null ? ` audio=${(args.audioBytes / 1024).toFixed(0)}KB` : args.inputChars != null ? ` inputChars=${args.inputChars}` : "";
  args.onEvent?.(`gemini ${args.operation} model=${args.model} ${ms}ms${extra}`);
}
