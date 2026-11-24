# Reel Book — Instagram Reel Transcription & Knowledge Archive

Turn Instagram Reels into a structured, searchable, version-controlled knowledge base. Each reel becomes one Markdown document — transcribed, formatted, and archived by creator — with SQLite checkpoints so incremental syncs only ever process what's new.

```
Reel URL → audio → transcript → formatted doc → creators/<user>/YYYY/MM/*.md
```

## Features

- **Per-reel pipeline** — `DISCOVERED → QUEUED → TRANSCRIBING → FORMATTING → COMPLETED`, persisting after every stage. A failed run resumes where it stopped; nothing is ever transcribed or billed twice.
- **Incremental sync** — per-creator checkpoints (`last_successful_sync_at` vs `last_seen_published_at`), overlap window, ID-based dedup. Re-runs process only new reels.
- **Pluggable providers** — discovery, media, transcription, and formatting are all interfaces. Swap mock ↔ local ↔ cloud without touching the pipeline.
- **Free local stack** — whisper.cpp transcription + Ollama formatting: $0, no quotas, fully offline except media download.
- **Cloud stack** — Gemini audio transcription + structured-JSON formatting.
- **Git-native archive** — optional auto-commit, frontmatter traceability (`instagram_id`, `reel_url`), raw transcript preserved in every doc + DB.
- **Bulk-ready** — `--limit` batches, per-reel cleanup, retries with backoff, `doctor` pre-flight checks.

## Quick start

```bash
pnpm install
cp .env.example .env   # then fill in keys (see Configuration)
pnpm db:migrate
pnpm test
pnpm dev doctor        # verifies ffmpeg, whisper, API keys, archive, DB
```

## Usage

**1. Register a creator**

```bash
pnpm dev add-creator https://www.instagram.com/creator_username/
```

**2. Prepare reel URLs** (`url.txt` — one per line, or the JSON shape below; see `url.example.txt`)

```json
{
  "urls": ["https://www.instagram.com/reel/ABC123/"],
  "meta": {
    "https://www.instagram.com/reel/ABC123/": {
      "publishedAt": "2026-11-13T10:00:00Z",
      "caption": "optional caption"
    }
  }
}
```

**3. Sync + process** (incremental — only new IDs are processed)

```bash
# Fully free: unofficial download + local whisper + local ollama, no AI-vendor calls
pnpm dev sync creator_username --reels reels.json --media ytdlp --transcriber local --formatter ollama --limit 25 --commit

# No-AI archiving: original transcript stored as-is (no LLM anywhere)
pnpm dev sync creator_username --reels reels.json --media ytdlp --transcriber local --formatter verbatim --limit 25 --commit

# Cloud quality: Gemini transcription + formatting
pnpm dev sync creator_username --reels reels.json --media ytdlp --transcriber gemini --formatter gemini --limit 25 --commit
```

**4. Operate**

```bash
pnpm dev status [username]            # sync state + pending reels
pnpm dev retry username --limit 25    # resume failed/pending (stages never redo)
pnpm dev sync username --full         # historical rescan (dedup keeps it safe)
pnpm dev schedule --once --commit     # all creators, via inbox files (see below)
pnpm dev reprocess username --formatter ollama --force   # reformat without re-transcribing
pnpm dev reset-reel username ABC123 --delete-file        # redo one reel from scratch
pnpm dev init-template                # write customizable markdown template
```

## Discovery options

| Mode | Flag | Notes |
|---|---|---|
| Manual URLs | `--reels reels.json` (default) | Creator-provided / authorized links. Always works. |
| Official Graph API | `--discovery graph --ig-user-id <ID>` | Business/Creator accounts you control. Needs `GRAPH_ACCESS_TOKEN`. Arbitrary public profiles are **not** enumerable — an API limitation, not a bug. |
| Scheduled inbox | `schedule --once` | Reads `<archive>/config/discovery/<username>.json` per creator. |
| Profile listing | — | Not supported: Instagram blocks logged-out listing. Paste reel URLs, or export a browser `cookies.txt` (`YTDLP_COOKIES_FILE`) for login-gated content. |

## Media options (`--media`)

| Kind | Notes |
|---|---|
| `mock` | Placeholder audio for smoke tests. Default when nothing else applies. |
| `local` | Your files via `--media-map '{"SHORTCODE": "/path/to.mp4"}'`. Never modified or deleted. |
| `graph` | Official API downloads (used automatically with `--discovery graph`). |
| `ytdlp` | **Explicit opt-in** (`ALLOW_UNOFFICIAL_DOWNLOAD=1`). Downloads outside Instagram's official APIs — use only for content you have the right to archive. |

Downloaded originals are transient: converted to mp3, transcribed, then deleted. Only transcripts + markdown persist.

## Transcription & formatting

| Transcriber | Command | Cost |
|---|---|---|
| `local` | whisper.cpp (`whisper-cli` + `./models/ggml-base.bin`) | Free, offline |
| `gemini` | `GEMINI_TRANSCRIBE_MODEL` (default `gemini-3.5-flash`) | Per-call billing past free tier |

| Formatter | Command | Cost |
|---|---|---|
| `verbatim` | Original transcript as-is, deterministic heading | Free |
| `ollama` | Local LLM (default `qwen2.5:7b-instruct`, needs `ollama serve`) | Free |
| `gemini` | Structured-JSON formatting (`GEMINI_FORMAT_MODEL`) | Per-call billing past free tier |
| `mock` | Placeholder for smoke tests | — |

Swap models per run without touching `.env`: `--transcribe-model ... --format-model ...`.

## Configuration (`.env`)

| Key | Purpose |
|---|---|
| `GEMINI_API_KEY` | AI Studio key (a Pro subscription alone is not enough — the app calls the API) |
| `GEMINI_FORMAT_MODEL` / `GEMINI_TRANSCRIBE_MODEL` | Model overrides (verified: `gemini-3.5-flash`; `2.5-flash` is retired for new users) |
| `ARCHIVE_ROOT` / `DATABASE_PATH` / `SYNC_OVERLAP_DAYS` | Storage + sync behavior |
| `ARCHIVE_TEMPLATE_PATH` | Custom markdown template (`init-template` to scaffold) |
| `ARCHIVE_GIT_AUTOCOMMIT` | Commit docs after each run |
| `ALLOW_UNOFFICIAL_DOWNLOAD` | `=1` enables `--media ytdlp` (opt-in, see Media) |
| `YTDLP_COOKIES_FILE` | Login-gated content |
| `GRAPH_ACCESS_TOKEN` / `GRAPH_IG_USER_ID` | Official API discovery |
| `OLLAMA_FORMAT_MODEL` / `OLLAMA_BASE_URL` | Local formatting |

## Output layout

```
instagram-archive/
├── creators/<username>/YYYY/MM/<slug>.md   # one doc per reel + metadata.json
├── config/discovery/<username>.json        # scheduler inbox (optional)
├── config/template.md                      # custom template (optional)
└── database/archive.db                     # creators, reels, sync_runs
```

Every doc carries frontmatter (`instagram_id`, `reel_url`, timestamps) plus the verbatim `## Original Transcript` — traceable without opening the DB. Filenames are slugified, collision-proof, and never overwritten.

## Reliability guarantees

- Dedup key is `instagram_media_id` (UNIQUE) — headings/captions/dates never used for identity.
- `last_successful_sync_at` advances only after full paginated discovery succeeds.
- Each stage persists before the next; retries resume from the first missing artifact.
- One creator's failure never stops others; one reel's failure never stops the batch.

## Development

```bash
pnpm typecheck   # strict TS
pnpm test        # vitest (20 tests: dedup, collisions, resume, checkpoints, retry, batching)
pnpm build && pnpm start status
```

Stack: TypeScript + Node 26 · SQLite (better-sqlite3) + Drizzle · Commander CLI · Zod. No daemons, no external services required for the free stack.
