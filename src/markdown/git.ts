import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

export async function ensureArchiveRepo(archiveRoot: string): Promise<boolean> {
  try {
    if (!existsSync(join(archiveRoot, ".git"))) {
      await execFileAsync("git", ["init"], { cwd: archiveRoot });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Commit new/changed markdown docs. Returns commit hash or null if nothing to commit.
 * Never throws for "nothing to commit" — only for real git failures when explicitly requested.
 */
export async function commitArchive(archiveRoot: string, message: string): Promise<string | null> {
  const ok = await ensureArchiveRepo(archiveRoot);
  if (!ok) return null;
  try {
    await git(archiveRoot, ["add", "creators"]);
  } catch {
    return null; // e.g. no creators dir yet
  }
  const status = await git(archiveRoot, ["status", "--porcelain"]).catch(() => "");
  if (!status) return null;
  try {
    await git(archiveRoot, ["-c", "user.name=reel-book", "-c", "user.email=reel-book@local", "commit", "-m", message]);
    return await git(archiveRoot, ["rev-parse", "HEAD"]);
  } catch {
    return null;
  }
}
