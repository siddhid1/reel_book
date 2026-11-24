# Reel Book — Instagram Reel Transcription & Knowledge Archive

Local-first pipeline: discover reels → extract audio → transcribe → AI-format with Gemini → Markdown archive (git-friendly) with SQLite checkpoints for incremental sync.

## Quick start

```bash
pnpm install
cp .env.example .env
# Get key at https://aistudio.google.com/apikey and put in .env as GEMINI_API_KEY
# (Google AI Pro subscription alone is not enough — the app calls the Generative Language API)
pnpm db:migrate
pnpm test
```

## Usage (M2 v1: manual/authorized discovery — no scraping)

1. Register creator:
```bash
pnpm dev add-creator https://www.instagram.com/creator_username/
```

2. Prepare `reels.json` (creator-provided / authorized URLs):
```json
{
  "urls": ["https://www.instagram.com/reel/ABC123/", "https://www.instagram.com/reel/DEF456/"],
  "meta": {
    "https://www.instagram.com/reel/ABC123/": {"publishedAt": "2026-11-13T10:00:00Z", "caption": "optional caption"}
  }
}
```

3. Optional `media-map.json` (shortcode or URL → local authorized media file):
```json
{ "ABC123": "/path/to/abc123.mp4", "https://www.instagram.com/reel/DEF456/": "/path/to/def.mp4" }
```
Requires `ffmpeg` for video→audio extraction. For offline smoke tests, omit media and use `--transcriber mock --formatter mock`.

4. Sync + process (incremental; only new IDs processed):
```bash
pnpm dev sync creator_username --reels reels.json --media-map media-map.json --transcriber mock --formatter mock
pnpm dev sync creator_username --reels reels.json --media-map media-map.json --transcriber gemini --formatter gemini
pnpm dev retry creator_username --media-map media-map.json --transcriber gemini --formatter gemini
pnpm dev status creator_username
```

Output: `instagram-archive/creators/<username>/YYYY/MM/<slug>.md` + `creators/<username>/metadata.json` + `instagram-archive/database/archive.db`.

### Graph media downloads

When discovered via `--discovery graph`, audio is fetched through the official API automatically (`--media auto` picks `graph`); no `--media-map` needed:

```bash
pnpm dev sync creator_username --discovery graph --ig-user-id <IG_SCOPED_ID> --transcriber gemini --formatter gemini --commit
```

Requires `ffmpeg` for video→audio extraction. `--media local|graph|mock` overrides the auto choice.

### Direct URL download (opt-in)

Paste a reel URL → real transcript, no files needed — but explicitly opt-in, because it fetches media outside Instagram's official APIs (may violate their Terms; use only for content you have the right to archive):

```bash
# in .env: ALLOW_UNOFFICIAL_DOWNLOAD=1
pnpm dev sync creator_username --reels reels.json --media ytdlp --transcriber gemini --formatter gemini --commit
```

If Instagram demands login, export a `cookies.txt` from your browser and set `YTDLP_COOKIES_FILE`. The default pipeline (`auto`/`mock`/`local`/`graph`) never touches this path.

### Reprocess after a prompt change (no re-transcribe)

```bash
pnpm dev reprocess creator_username --formatter gemini --force --limit 10 --commit
```

Re-runs formatting for reels with raw transcripts and rewrites their markdown in place. Without `--force`, only unformatted/failed reels are touched.

### Custom markdown template

```bash
pnpm dev init-template              # writes ./instagram-archive/config/template.md
# set ARCHIVE_TEMPLATE_PATH=./instagram-archive/config/template.md in .env
```

Tokens: `{{title}} {{creator}} {{instagram_id}} {{reel_url}} {{published_at}} {{processed_at}} {{body}} {{raw_transcript}}`.

### Pre-flight checks

```bash
pnpm dev doctor   # ffmpeg, whisper, API keys (masked), live Gemini probe, archive + DB
```

## Official Graph API discovery (optional)

For Business/Creator accounts you have access to (token with `instagram_business_basic` scopes):

```bash
pnpm dev sync creator_username --discovery graph --ig-user-id <IG_SCOPED_ID> --transcriber gemini --formatter gemini
```

Set `GRAPH_ACCESS_TOKEN` / `GRAPH_IG_USER_ID` in `.env`. Arbitrary public profiles are NOT enumerable — that is an API limitation, not a bug; fall back to manual `reels.json`. Failures surface loudly, never as silent empty records.

## Scheduling + git auto-commit + full rescan

```bash
# one-shot: sync all creators using inbox files at <archive>/config/discovery/<username>.json
pnpm dev schedule --once --transcriber gemini --formatter gemini --commit

# daemon: every 60 min (also runs immediately on start)
pnpm dev schedule --interval-min 60 --transcriber gemini --formatter gemini --commit

# commit-on-write for single-creator runs (or set ARCHIVE_GIT_AUTOCOMMIT=true)
pnpm dev sync creator_username --reels reels.json --commit

# full historical reconciliation (ignores checkpoint, dedup still by media ID)
pnpm dev sync creator_username --reels reels.json --full

# bulk in controlled batches of 25 (each run commits; resume anytime by re-running)
pnpm dev sync creator_username --reels bulk.json --media ytdlp --transcriber gemini --formatter gemini --limit 25 --commit

# if a model is overloaded, swap per run without touching .env
pnpm dev sync creator_username --reels bulk.json --media ytdlp --transcriber gemini --formatter gemini --limit 25 --format-model gemini-3-flash-preview --commit
```

## Gemini notes (your Pro subscription)

- Model defaults are `gemini-3.5-flash` for both formatting and transcription (verified working 2026-11-23; `gemini-2.5-flash` now returns 404 for new API users, `gemini-3.8-flash` was 503-overloaded). Override via `GEMINI_FORMAT_MODEL` / `GEMINI_TRANSCRIBE_MODEL`.
- API calls retry 429/5xx with exponential backoff and log model + latency + size per call.
- Transcription: `--transcriber gemini` sends audio with a strict verbatim prompt. Audio must be <20MB inline (reels are fine). For bulk/offline, install `ffmpeg` + `whisper.cpp` (`pnpm dev doctor` tells you what's missing) and use `--transcriber local`.
- The subscription login itself is not enough — the app needs `GEMINI_API_KEY` from AI Studio, which you have configured.

## Guarantees

- Dedup key is `instagram_media_id` (UNIQUE). Headings/captions/dates never used for identity.
- `last_successful_sync_at` advances only after full paginated discovery succeeds; failures leave checkpoints untouched.
- Each stage persists before the next: failed formatting retries from formatting (transcript reused); failed markdown retries from markdown.
- Markdown files are never overwritten; collisions get `-<shortId>` suffixes. Frontmatter traces every doc to its reel URL + raw transcript preserved in-file and in DB.
