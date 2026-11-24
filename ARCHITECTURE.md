# Reel Book — Architecture & Workflow Deep Analysis

## 1. System in one paragraph

Reel Book is a **local-first, modular-monolith CLI pipeline** that converts Instagram Reels into a version-controlled Markdown knowledge base. A run has five stages — **discover → fetch media → transcribe → format → archive** — orchestrated against a SQLite database that acts as both job queue and checkpoint store. Every external capability (Reel listing, media download, speech-to-text, LLM formatting) sits behind a provider interface, so the core pipeline never depends on Instagram, Google, or any specific tool. All 354 reels of the pilot account (`pranavprakash_3`) were processed through this exact flow.

## 2. Design principles (and where they bite)

| Principle | Implementation | Evidence in this repo |
|---|---|---|
| Local-first | SQLite + filesystem archive; free stack needs no network except media download | 334 reels done with `$0` spend |
| Idempotency | `instagram_media_id` UNIQUE; re-runs process only new/failed work | "354 found, 0 new" re-runs |
| Stage persistence | Each stage's output is saved before advancing | Failed formatting resumes without re-transcribing |
| Checkpoints never advance on failure | `last_successful_sync_at` updates only after full paginated discovery | Covered by test |
| Authorized-first, opt-in otherwise | Default path uses official/creator-provided media; yt-dlp is env-gated with warnings | `ALLOW_UNOFFICIAL_DOWNLOAD` |
| Failures are data | Every failure lands in `last_error` + a `FAILED_*` state, never an exception crash | 429s and 503s all recovered |

## 3. Component map

```
┌─────────┐  ┌───────────┐  ┌───────┐  ┌───────────────┐  ┌────────────┐  ┌──────────┐
│   CLI   │→ │   Sync    │→ │ Queue │→ │   Providers   │→ │  Markdown  │→ │   Git    │
│commander│  │checkpoints│  │state  │  │ disco/media/  │  │  template  │  │autocommit│
│         │  │overlap+   │  │machine│  │ transcribe/   │  │  slugger   │  │          │
│         │  │dedup      │  │resume │  │ format        │  │  metadata  │  │          │
└─────────┘  └───────────┘  └───────┘  └───────────────┘  └────────────┘  └──────────┘
      ↘              ↘            ↘               ↘                  ↘
       └──────────────┴────────────┴───── SQLite (better-sqlite3 + Drizzle) ──────┘
```

Module layout (`src/`): `cli/`, `sync/` (service + scheduler), `queue/` (processor), `discovery/` (manual, graph), `media/` (local-file, graph, ytdlp, mock), `transcription/` (local-whisper, gemini, mock), `formatting/` (verbatim, ollama, gemini, mock), `markdown/` (generator, template, git), `creator/` (metadata), `db/` (schema, client, repositories), `config/`, `utils/` (retry).

## 4. Data model

**creators** — identity + sync watermarks:
`id, username UNIQUE, profile_url, created_at, last_sync_attempt_at, last_successful_sync_at, last_seen_published_at, sync_status`

**reels** — one row per Reel, the unit of work:
`id, creator_id FK, instagram_media_id UNIQUE NOT NULL, reel_url, published_at, caption, raw_transcript, formatted_body, generated_heading, markdown_path UNIQUE, processing_status, last_error, retry_count, created_at, updated_at`

**sync_runs** — audit log of every discovery execution:
`id, creator_id FK, started_at, completed_at, status, reels_discovered, reels_new, reels_processed, reels_failed, error_message, cursor_state`

Key semantic split: `last_successful_sync_at` (when discovery last completed) vs `last_seen_published_at` (newest Reel seen). conflating them would either reprocess history or skip Reels — they are updated together but mean different things.

## 5. End-to-end workflow (the full path a Reel travels)

```
User pastes URL(s)
  → normalizeCreator() validates handle / profile URL
  → creatorRepo.upsert() registers creator (idempotent)
  → syncCreator():
      load last_seen_published_at, subtract overlap window (default 7d)
      loop discovery pages (cursor) → insertIfNew() (INSERT OR IGNORE on media id)
      ONLY on full success: advance checkpoints + mark sync_run SUCCEEDED
  → processPendingReels() — per reel:
      ① fetchAudio(url, workDir, mediaId)      [media provider]
      ② transcribe(audio) → raw (DB persist)    [transcription provider]
      ③ format(raw, caption) → heading+body     [formatting provider, SKIPPED by verbatim]
      ④ uniqueMarkdownPath() → render → write   [markdown module]
      ⑤ update row COMPLETED + writeCreatorMetadata()
  → commitArchive() (optional): git add creators/ + commit
```

State machine: `DISCOVERED → QUEUED → TRANSCRIBING → FORMATTING → COMPLETED`, with `FAILED_TRANSCRIPTION / FAILED_FORMATTING / FAILED_MARKDOWN / UNAVAILABLE` as retryable exits. The processor re-reads each row fresh, so killing the process mid-run is safe — the next run resumes from the first missing artifact (e.g. raw present + formatted missing → starts at formatting, no re-download).

Filename safety: `slugify(heading) + -<shortId> + -2…`, checked against all known DB paths **and** the filesystem — never overwrites.

## 6. Provider matrix (what ran in production here)

| Concern | Providers | Pilot usage |
|---|---|---|
| Discovery | `manual` (URL list), `instagram-graph` (official API) | manual, 354 URLs |
| Media | `local-file` (user files, never deleted), `graph` (official CDN), `ytdlp` (opt-in), `mock` | ytdlp (opt-in flag set) |
| Transcription | `local-whisper` (whisper.cpp base, CPU), `gemini` (multimodal), `mock` | local-whisper after quota wall |
| Formatting | `verbatim` (no AI), `ollama` (qwen2.5:7b local), `gemini` (structured JSON), `mock` | verbatim for bulk |

Cross-cutting hardening lives in `utils/retry.ts`: 60s request timeout, retry on 429/5xx/network with exponential backoff + `Retry-After` support, per-call model/latency/size logging. Gemini observed flapping (503s, then a 10-minute hung socket) — both are now bounded.

## 7. Failure modes observed live (354-reel pilot)

1. **Gemini free-tier quota (429, 20 req/day)** — hit at reel 5. Transcription moved to local Whisper ($0, unlimited); formatting moved to `verbatim`/`ollama`. Lesson: keep transcribe and format on independent providers so a quota wall in one never blocks the other.
2. **Instagram download throttling (end of bulk)** — 3/354 yt-dlp fetches rejected after 300+ rapid downloads. Parked as retryable; mitigation path is `YTDLP_COOKIES_FILE` or time-spaced batches.
3. **Model retirement without notice** — `gemini-2.5-flash` returned 404 for new users mid-project; provider model is env-configurable so the fix was a one-line change.
4. **ASR roughness (whisper base)** — minor word errors preserved verbatim by design; upgrade path is the `small` model or an AI polish pass (`reprocess --formatter …`) without re-transcribing.

## 8. Operating the system

- Bulk: `--limit N` batches + `--commit` each; `retry`/`reprocess`/`reset-reel` for recovery and re-dos.
- Scheduled: `schedule --once` (inbox files) or `--interval-min` daemon; per-creator failures never stop others.
- Pre-flight: `doctor` checks ffmpeg, whisper binary + model, ollama server + models, keys (masked), live Gemini probe, archive writability, DB.
- Cost control: `--transcribe-model/--format-model` per-run overrides; `verbatim` eliminates formatting cost entirely.

## 9. Deliberate limitations

- No profile enumeration for arbitrary public accounts (Instagram blocks logged-out listing; official API only covers accounts you control). Input is reel URLs — a constraint, not a gap.
- No video retention: audio is transient (auto-deleted post-transcription); only transcripts + markdown persist.
- `verbatim` headings are first-sentences (archival, not pretty); polish is a later `reprocess` pass.
- Scheduler has no `--limit`; bulk runs use the `run_all.sh` batch loop pattern instead.

## 10. Extension points (all interface-level, no core changes)

New discovery/media/transcription/formatter = one class implementing the provider interface + one line in the CLI factory. Natural next steps: `small`-model Whisper, embeddings + vector search over the archive, Obsidian export template, language detection, Graph media wiring for connected accounts.
```

## Verification status (live, this machine)

- 20/20 vitest green, `tsc` clean, `doctor` green (ffmpeg OK, whisper OK, ollama OK, Gemini probe 200 when quota allows).
- Pilot: 334/354 reels fully transcribed + archived; 17 queued; 3 download-throttled (retryable). Zero duplicate records, zero lost work, zero spend on the free stack.
