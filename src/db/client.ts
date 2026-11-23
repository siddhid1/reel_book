import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { creators, reels, syncRuns } from "./schema.js";

let db: BetterSQLite3Database | null = null;
let sqlite: Database.Database | null = null;

export function getDb(dbPath: string): BetterSQLite3Database {
  if (db && sqlite) return db;
  mkdirSync(dirname(dbPath), { recursive: true });
  sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  db = drizzle(sqlite);
  ensureTables(sqlite);
  return db;
}

function ensureTables(s: Database.Database): void {
  s.exec(`
    CREATE TABLE IF NOT EXISTS creators (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      profile_url TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_sync_attempt_at TEXT,
      last_successful_sync_at TEXT,
      last_seen_published_at TEXT,
      sync_status TEXT NOT NULL DEFAULT 'IDLE'
    );
    CREATE TABLE IF NOT EXISTS reels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      creator_id INTEGER NOT NULL REFERENCES creators(id),
      instagram_media_id TEXT NOT NULL UNIQUE,
      reel_url TEXT NOT NULL,
      published_at TEXT,
      caption TEXT,
      raw_transcript TEXT,
      formatted_body TEXT,
      generated_heading TEXT,
      markdown_path TEXT UNIQUE,
      processing_status TEXT NOT NULL DEFAULT 'DISCOVERED',
      last_error TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      creator_id INTEGER NOT NULL REFERENCES creators(id),
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL DEFAULT 'RUNNING',
      reels_discovered INTEGER NOT NULL DEFAULT 0,
      reels_new INTEGER NOT NULL DEFAULT 0,
      reels_processed INTEGER NOT NULL DEFAULT 0,
      reels_failed INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      cursor_state TEXT
    );
  `);
}

export { creators, reels, syncRuns };
