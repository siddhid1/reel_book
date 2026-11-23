import { config } from "dotenv";
config();

function req(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export interface AppConfig {
  archiveRoot: string;
  databasePath: string;
  geminiApiKey: string;
  geminiFormatModel: string;
  geminiTranscribeModel: string;
  syncOverlapDays: number;
  graphAccessToken: string;
  graphIgUserId: string;
  archiveGitAutocommit: boolean;
  archiveTemplatePath: string;
}

export function loadConfig(): AppConfig {
  const archiveRoot = req("ARCHIVE_ROOT", "./instagram-archive");
  return {
    archiveRoot,
    databasePath: req("DATABASE_PATH", `${archiveRoot}/database/archive.db`),
    geminiApiKey: req("GEMINI_API_KEY", ""),
    geminiFormatModel: req("GEMINI_FORMAT_MODEL", "gemini-3.5-flash"),
    geminiTranscribeModel: req("GEMINI_TRANSCRIBE_MODEL", "gemini-3.5-flash"),
    syncOverlapDays: Number(req("SYNC_OVERLAP_DAYS", "7") || "7"),
    graphAccessToken: req("GRAPH_ACCESS_TOKEN", ""),
    graphIgUserId: req("GRAPH_IG_USER_ID", ""),
    archiveGitAutocommit: req("ARCHIVE_GIT_AUTOCOMMIT", "false").toLowerCase() === "true",
    archiveTemplatePath: req("ARCHIVE_TEMPLATE_PATH", ""),
  };
}

export function getTemplatePath(config: AppConfig): string | null {
  return config.archiveTemplatePath || null;
}
