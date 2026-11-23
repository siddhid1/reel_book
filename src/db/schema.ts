import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const PROCESSING_STATUSES = [
  "DISCOVERED",
  "QUEUED",
  "TRANSCRIBING",
  "FORMATTING",
  "COMPLETED",
  "FAILED_TRANSCRIPTION",
  "FAILED_FORMATTING",
  "FAILED_MARKDOWN",
  "UNAVAILABLE",
] as const;
export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number];

export const SYNC_STATUSES = ["IDLE", "RUNNING", "SUCCEEDED", "FAILED"] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

export const creators = sqliteTable("creators", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  profileUrl: text("profile_url").notNull(),
  createdAt: text("created_at").notNull(),
  lastSyncAttemptAt: text("last_sync_attempt_at"),
  lastSuccessfulSyncAt: text("last_successful_sync_at"),
  lastSeenPublishedAt: text("last_seen_published_at"),
  syncStatus: text("sync_status").notNull().default("IDLE"),
});

export const reels = sqliteTable("reels", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  creatorId: integer("creator_id")
    .notNull()
    .references(() => creators.id),
  instagramMediaId: text("instagram_media_id").notNull().unique(),
  reelUrl: text("reel_url").notNull(),
  publishedAt: text("published_at"),
  caption: text("caption"),
  rawTranscript: text("raw_transcript"),
  formattedBody: text("formatted_body"),
  generatedHeading: text("generated_heading"),
  markdownPath: text("markdown_path").unique(),
  processingStatus: text("processing_status").notNull().default("DISCOVERED"),
  lastError: text("last_error"),
  retryCount: integer("retry_count").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const syncRuns = sqliteTable("sync_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  creatorId: integer("creator_id")
    .notNull()
    .references(() => creators.id),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  status: text("status").notNull().default("RUNNING"),
  reelsDiscovered: integer("reels_discovered").notNull().default(0),
  reelsNew: integer("reels_new").notNull().default(0),
  reelsProcessed: integer("reels_processed").notNull().default(0),
  reelsFailed: integer("reels_failed").notNull().default(0),
  errorMessage: text("error_message"),
  cursorState: text("cursor_state"),
});
