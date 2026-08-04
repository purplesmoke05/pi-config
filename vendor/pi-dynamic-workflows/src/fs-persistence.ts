/**
 * Shared filesystem primitives for JSON-backed persistence.
 *
 * Both run-persistence.ts (workflow runs) and workflow-saved.ts (saved
 * workflow commands) persist plain-JSON records to per-record files under a
 * project/user directory, and both need the same four guarantees:
 *
 *  1. Atomic writes with a recovery backup — a crash mid-write must never
 *     corrupt the live file, and a later-discovered-truncated primary must
 *     still be recoverable from the last good write.
 *  2. Corrupt-file recovery on read — a truncated/corrupt primary falls back
 *     to its `.bak` sidecar instead of losing the record.
 *  3. A missing directory degrades to "no files" while permission and I/O
 *     failures remain visible. Corrupt JSON falls back to its backup without
 *     disguising an unreadable file as a missing record.
 *  4. Persisted state is private by construction — directories are 0700 and
 *     JSON/tmp/backup/lock files are 0600, including pre-existing paths when
 *     they are next touched. Permission-hardening failures are surfaced.
 *
 * This module is the single implementation of all four; run-persistence.ts
 * and workflow-saved.ts both call into it rather than maintaining parallel
 * copies.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** Filesystem operations used by JSON persistence. Exposed for testing. */
export type PersistenceFsLayer = {
  chmodSync: typeof chmodSync;
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
  readdirSync: typeof readdirSync;
  readFileSync: typeof readFileSync;
  renameSync: typeof renameSync;
  statSync: typeof statSync;
  unlinkSync: typeof unlinkSync;
  writeFileSync: typeof writeFileSync;
};

/** The real node:fs implementations. */
export function defaultPersistenceFs(): PersistenceFsLayer {
  return {
    chmodSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
  };
}

/** Merge a partial test override on top of the real node:fs implementations. */
export function resolvePersistenceFs(overrides?: Partial<PersistenceFsLayer>): PersistenceFsLayer {
  const base = defaultPersistenceFs();
  return overrides ? { ...base, ...overrides } : base;
}

/** Owner-only modes for workflow persistence containing scripts, prompts, and results. */
export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Ensure `dir` exists and harden both new and pre-existing directories. */
export function ensureDir(fs: PersistenceFsLayer, dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  fs.chmodSync(dir, PRIVATE_DIRECTORY_MODE);
}

/** Harden a private directory when it exists, tolerating only deletion races. */
export function enforcePrivateDirectoryModeIfExists(fs: PersistenceFsLayer, dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  try {
    fs.chmodSync(dir, PRIVATE_DIRECTORY_MODE);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

/** Apply the owner-only mode to a known existing sensitive file. */
export function enforcePrivateFileMode(fs: PersistenceFsLayer, path: string): void {
  fs.chmodSync(path, PRIVATE_FILE_MODE);
}

/**
 * Harden a sensitive file when it exists. Concurrent deletion is benign;
 * permission errors and every other chmod failure remain visible to callers.
 */
export function enforcePrivateFileModeIfExists(fs: PersistenceFsLayer, path: string): boolean {
  if (!fs.existsSync(path)) return false;
  try {
    enforcePrivateFileMode(fs, path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

/**
 * Atomically write JSON to `path`: tmp-write + rename (atomic on the same
 * filesystem, so a crash mid-write can't corrupt the live file), then
 * refresh a `.bak` sidecar from the just-written good state —
 * the recovery fallback readJsonWithBackupRecovery() uses if the primary is
 * later found truncated (e.g. a rename that itself got interrupted by a
 * power loss on a filesystem/OS combination where rename isn't fully atomic).
 */
export function writeJsonAtomicWithBackup(fs: PersistenceFsLayer, path: string, data: unknown): void {
  const json = JSON.stringify(data, null, 2);
  const tmpPath = `${path}.tmp`;
  const backupPath = `${path}.bak`;
  enforcePrivateFileModeIfExists(fs, tmpPath);
  fs.writeFileSync(tmpPath, json, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  enforcePrivateFileMode(fs, tmpPath);
  fs.renameSync(tmpPath, path);
  enforcePrivateFileMode(fs, path);
  enforcePrivateFileModeIfExists(fs, backupPath);
  fs.writeFileSync(backupPath, json, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  enforcePrivateFileMode(fs, backupPath);
}

/**
 * Read JSON from `path`, falling back to `path.bak` if the primary is
 * missing or fails to parse. Returns null if neither candidate parses.
 */
export function readJsonWithBackupRecovery<T>(fs: PersistenceFsLayer, path: string): T | null {
  enforcePrivateDirectoryModeIfExists(fs, dirname(path));
  for (const candidate of [path, `${path}.bak`]) {
    if (!enforcePrivateFileModeIfExists(fs, candidate)) continue;
    let json: string;
    try {
      json = fs.readFileSync(candidate, "utf-8");
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }
    try {
      return JSON.parse(json) as T;
    } catch {
      // Corrupt candidate -> fall through to the next candidate.
    }
  }
  return null;
}

/**
 * List `.json` record files in `dir`. A missing directory (never created yet,
 * or deleted during a read race) degrades to an empty list. Permission and
 * other I/O failures propagate so callers cannot mistake inaccessible state
 * for an empty history.
 */
export function listJsonFilesSafe(fs: PersistenceFsLayer, dir: string): string[] {
  if (!enforcePrivateDirectoryModeIfExists(fs, dir)) return [];
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
}

/** Unlink when present; tolerate deletion races but surface permission and I/O failures. */
export function unlinkIfExistsSafe(fs: PersistenceFsLayer, path: string): boolean {
  try {
    if (fs.existsSync(path)) {
      fs.unlinkSync(path);
      return true;
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  return false;
}
