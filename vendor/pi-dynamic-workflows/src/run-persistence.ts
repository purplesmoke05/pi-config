/**
 * Workflow run state persistence for pause/resume support.
 */

import type { Stats } from "node:fs";
import { join } from "node:path";
import type { AgentUsage } from "./agent.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import type { WorkflowErrorCode } from "./errors.js";
import {
  enforcePrivateDirectoryModeIfExists,
  enforcePrivateFileMode,
  enforcePrivateFileModeIfExists,
  ensureDir as ensureDirFs,
  isMissingPathError,
  listJsonFilesSafe,
  type PersistenceFsLayer,
  PRIVATE_FILE_MODE,
  resolvePersistenceFs,
  unlinkIfExistsSafe,
  writeJsonAtomicWithBackup,
} from "./fs-persistence.js";
import { workflowProjectPaths } from "./workflow-paths.js";
import type { WorkflowExecutionSource } from "./workflow-trust.js";

export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "aborted";

export interface PersistedAgentState {
  id: number;
  /** Runtime call identity (`${runId}:${callIndex}`), used to rehydrate journaled results. */
  callId?: string;
  label: string;
  phase?: string;
  prompt: string;
  status: "queued" | "running" | "done" | "error" | "skipped";
  result?: unknown;
  /** Compact result written by releases before full agent results were retained. */
  resultPreview?: string;
  error?: string;
  errorCode?: WorkflowErrorCode;
  recoverable?: boolean;
  history?: AgentHistoryEntry[];
  startedAt?: string;
  endedAt?: string;
  /** Tokens used by this agent (a scalar estimate when the provider reports no usage). */
  tokens?: number;
  /** Per-agent token usage breakdown, when the provider reported one. */
  tokenUsage?: AgentUsage;
  /** The model this agent ran on (provider/id), when known. */
  model?: string;
}

export interface PersistedRunState {
  runId: string;
  workflowName: string;
  script: string;
  /** Audited built-in or custom code. Missing legacy values are treated as custom. */
  source?: WorkflowExecutionSource;
  /** Curated registry identity; required to regenerate and verify a built-in before unattended resume. */
  builtinName?: string;
  args?: unknown;
  /** The pi session this run belongs to. Runs persist on disk across sessions but
   * the navigator shows only the current session's runs (undefined = legacy/global). */
  sessionId?: string;
  status: RunStatus;
  /** Why a paused run is paused (e.g. "usage_limit" when a provider quota was hit). */
  pauseReason?: string;
  /** Provider reset hint for a usage-limit pause, e.g. "Resets in ~3h" (verbatim). */
  resetHint?: string;
  phases: string[];
  currentPhase?: string;
  agents: PersistedAgentState[];
  logs: string[];
  result?: unknown;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  durationMs?: number;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  /**
   * Cached agent/checkpoint results for resume, keyed by deterministic call
   * index. `runId` namespaces `index` (a nested workflow() call restarts its
   * own callSeq at 0) — absent on journals persisted before that namespacing
   * existed; see JournalEntry.runId in workflow.ts for the resume-time
   * legacy-degradation behavior. `storeDelta` is this call's SharedStore
   * write delta, replayed additively on resume.
   */
  journal?: Array<{
    index: number;
    runId?: string;
    hash: string;
    result: unknown;
    storeDelta?: Record<string, unknown>;
  }>;
  /**
   * Opt-out of auto-resume for this run (default true, i.e. eligible unless
   * explicitly set to false via ExecOptions.autoResume). Set once at run start
   * and carried through resumes; see UsageLimitScheduler.
   */
  autoResume?: boolean;
  /**
   * The run's resolved hard token budget, fixed at start (per-run value, else
   * the manager default at the time). Resume re-applies THIS value — never the
   * current default — so an explicit no-budget (`null`) or custom cap survives
   * a pause/resume cycle. Absent on legacy runs (resumed unbudgeted).
   */
  tokenBudget?: number | null;
  /**
   * Named toolset tag (WorkflowManagerOptions.toolsets). ToolDefinitions are
   * functions and can't be serialized, so this tag is how a resumed run (e.g.
   * /deep-research with web tools) re-resolves the tool set it started with.
   */
  toolset?: string;
  /**
   * The run's resolved cap on total agents, fixed at start (per-run value,
   * else undefined so runWorkflow applies its own MAX_AGENTS_PER_RUN default).
   * Resume re-applies THIS value — never the manager's current default — same
   * rationale as tokenBudget. Absent on legacy runs (resumed with no cap
   * carried forward, i.e. runWorkflow's own default applies).
   */
  maxAgents?: number;
  /**
   * The run's resolved per-agent timeout, fixed at start (per-run value, else
   * the manager default at the time). Absent on legacy runs — unlike
   * tokenBudget, a legacy run's real timeout was never "no timeout" by
   * omission; it was always the manager's default (pre-A1 resume always fell
   * back to it), so resume applies the manager's CURRENT default for such
   * runs rather than null, preserving both the run's original semantics and
   * pre-fix resume behavior.
   */
  agentTimeoutMs?: number | null;
  /**
   * The run's resolved concurrency, fixed at start (per-run value, else the
   * manager's concurrency at the time). Same rationale as tokenBudget.
   */
  concurrency?: number;
  /**
   * The run's resolved agent-retry count, fixed at start (per-run value, else
   * the manager default at the time). Same rationale as tokenBudget.
   */
  agentRetries?: number;
  /**
   * Auto-resume attempt counter for the current usage_limit pause-cycle, owned
   * and persisted by UsageLimitScheduler (best-effort). Absent/0 means no
   * auto-resume attempt has been recorded yet.
   */
  autoResumeAttempts?: number;
}

export interface RunPersistence {
  /** Save current run state. */
  save(state: PersistedRunState): void;
  /** Load a persisted run by ID. */
  load(runId: string): PersistedRunState | null;
  /** List all persisted runs. */
  list(): PersistedRunState[];
  /** Delete a persisted run. */
  delete(runId: string): boolean;
  /**
   * Acquire an exclusive cross-process lease for a run. Returns null when another
   * live process owns the run; stale/corrupt lock files are removed and retried.
   */
  acquireRunLease(runId: string): RunLease | null;
  /** Release a lease previously returned by acquireRunLease(). */
  releaseRunLease(lease: RunLease): void;
  /** Get runs directory path. */
  getRunsDir(): string;
}

export interface RunLease {
  runId: string;
  token: string;
}

interface LockFile {
  runId: string;
  runPath: string;
  pid: number;
  startedAt: string;
  token: string;
}

/**
 * Filesystem operations used by run persistence.
 * Exposed for testing – pass overrides to inject mock implementations.
 * (Alias of the shared PersistenceFsLayer — see fs-persistence.ts.)
 */
export type FsLayer = PersistenceFsLayer;

/**
 * Retention policy for terminal (completed/failed/aborted) runs kept on
 * disk. Bounded so a long-lived project directory can't accumulate an
 * unbounded number of run files (each polled/listed on every list() call).
 * A run in "running" or "paused" status is NEVER counted against this cap
 * or evicted by it — only genuinely finished runs age out, oldest (by
 * updatedAt) first, once the terminal-run count exceeds the cap. 300 is
 * generous enough to cover weeks of typical usage while keeping list()'s
 * per-call directory scan bounded.
 */
export const DEFAULT_MAX_TERMINAL_RUNS_ON_DISK = 300;

const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(["completed", "failed", "aborted"]);

export interface RunPersistenceOptions {
  /** Override DEFAULT_MAX_TERMINAL_RUNS_ON_DISK (tests; advanced tuning). */
  maxTerminalRunsOnDisk?: number;
}

/**
 * Run IDs are persisted as filenames. Keep the filename component deliberately
 * narrow so a caller can never escape the runs directory through path syntax.
 */
const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeRunId(runId: unknown): runId is string {
  return typeof runId === "string" && SAFE_RUN_ID_PATTERN.test(runId);
}

export function assertSafeRunId(runId: unknown): asserts runId is string {
  if (!isSafeRunId(runId)) {
    throw new Error(
      "Run ID must be 1-128 ASCII letters, digits, dots, underscores, or hyphens, and start with a letter or digit.",
    );
  }
}

/**
 * `list()` does a full readdirSync + per-file readFileSync + JSON.parse of the
 * entire lifetime run history. It is called on essentially every progress tick
 * (task-panel re-render → WorkflowManager.listRuns()/listAllRuns()), so an
 * unbounded number of ticks each re-walked and re-parsed every run file on
 * disk. Cache the computed list for a short TTL — long enough to absorb a
 * burst of same-tick reads, short enough that a read from a DIFFERENT process
 * (or a mutation this instance doesn't own) still shows up quickly. Mirrors
 * the ~1s settings-read TTL cache in task-panel.ts.
 */
const LIST_CACHE_TTL_MS = 300;

export function createRunPersistence(
  cwd: string,
  fsOverride?: Partial<FsLayer>,
  options?: RunPersistenceOptions,
): RunPersistence {
  const fs = resolvePersistenceFs(fsOverride);
  const _existsSync = fs.existsSync;
  const _readFileSync = fs.readFileSync;
  const _statSync = fs.statSync;
  const _unlinkSync = fs.unlinkSync;
  const _writeFileSync = fs.writeFileSync;
  const maxTerminalRunsOnDisk = options?.maxTerminalRunsOnDisk ?? DEFAULT_MAX_TERMINAL_RUNS_ON_DISK;

  const paths = workflowProjectPaths(cwd);
  const runsDir = paths.runsDir;

  const ensureDir = () => ensureDirFs(fs, runsDir);

  const runPath = (dir: string, runId: string) => join(dir, `${runId}.json`);
  const primaryRunPath = (runId: string) => runPath(runsDir, runId);
  const lockPath = (dir: string, runId: string) => join(dir, `${runId}.lock`);
  const primaryLockPath = (runId: string) => lockPath(runsDir, runId);

  const pidIsAlive = (pid: number): boolean => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === "EPERM") return true;
      return false;
    }
  };

  const readLockAt = (path: string): LockFile | null => {
    if (!enforcePrivateFileModeIfExists(fs, path)) return null;
    let json: string;
    try {
      json = _readFileSync(path, "utf-8");
    } catch (error) {
      if (isMissingPathError(error)) return null;
      throw error;
    }
    try {
      return JSON.parse(json) as LockFile;
    } catch {
      return null;
    }
  };

  const readLock = (runId: string): LockFile | null => readLockAt(primaryLockPath(runId));

  const readRunState = (path: string, runId: string): PersistedRunState | null => {
    // Treat a parsed record with the wrong runId as an invalid candidate and
    // continue to the backup. This preserves crash recovery without allowing
    // one file to masquerade as a different run.
    for (const candidate of [path, `${path}.bak`]) {
      if (!enforcePrivateFileModeIfExists(fs, candidate)) continue;
      let json: string;
      try {
        json = _readFileSync(candidate, "utf-8");
      } catch (error) {
        if (isMissingPathError(error)) continue;
        throw error;
      }
      try {
        const parsed = JSON.parse(json) as unknown;
        if (!parsed || typeof parsed !== "object") continue;
        const state = parsed as PersistedRunState;
        if (state.runId === runId && isSafeRunId(state.runId)) return state;
      } catch {
        // Corrupt candidate -> fall through to the backup.
      }
    }
    return null;
  };

  // list() cache: recomputed lazily, invalidated synchronously by every
  // mutation this instance performs (save()/delete()) so a stale read can
  // never outlive a mutation this process made. A read from another process
  // (or a direct fs write bypassing this instance) is picked up once the TTL
  // elapses, same as before this cache existed on the next un-cached call.
  let listCache: PersistedRunState[] | undefined;
  let listCacheAt = 0;
  const invalidateListCache = () => {
    listCache = undefined;
  };

  // Per-file mtime+size+ino cache, keyed by absolute path: even once the
  // TTL-level listCache above expires (the active panel polls roughly every
  // 300ms, i.e. faster than or comparable to the TTL), most run files on
  // disk haven't changed since the last recompute. Re-stat is cheap; re-read
  // + re-JSON.parse is not, and scales with total lifetime run history, not
  // with what actually changed. A file whose (mtimeMs, size, ino) all match
  // what we last parsed is reused as-is instead of being re-read; entries
  // for files that vanished between recomputes are pruned so this cache
  // can't grow unbounded independent of what's actually on disk.
  //
  // ino is load-bearing, not redundant with mtime+size: save() writes via
  // tmp-write + rename (writeJsonAtomicWithBackup), and a rename onto an
  // existing path allocates a NEW inode for the replacement file. Two
  // consecutive saves landing in the same mtime tick (400ms-throttled
  // progress persists vs. 1-2s mtime granularity on HFS+/many network
  // mounts/some Docker volume drivers is entirely realistic) with
  // coincidentally equal byte length (e.g. "paused" and "failed" are the
  // same length) would otherwise be indistinguishable from "unchanged" by
  // (mtimeMs, size) alone — serving stale, previously-cached content
  // forever until something ELSE about the file changes. The inode always
  // changes on such a rename, so adding it closes that hole for free.
  const fileStateCache = new Map<string, { mtimeMs: number; size: number; ino: number; state: PersistedRunState }>();

  const computeList = (): PersistedRunState[] => {
    const byRunId = new Map<string, PersistedRunState>();
    const seenPaths = new Set<string>();
    for (const file of listJsonFilesSafe(fs, runsDir)) {
      const runId = file.endsWith(".json") ? file.slice(0, -".json".length) : "";
      // Directory listings are untrusted input. Only a filename produced by
      // the same safe runId grammar used by all direct APIs may be inspected.
      if (!isSafeRunId(runId) || file !== `${runId}.json`) continue;

      const path = join(runsDir, file);
      seenPaths.add(path);
      if (!enforcePrivateFileModeIfExists(fs, path)) {
        fileStateCache.delete(path);
        continue;
      }
      let stat: Stats;
      try {
        stat = _statSync(path);
      } catch (error) {
        fileStateCache.delete(path);
        if (isMissingPathError(error)) continue;
        throw error;
      }
      try {
        const cached = fileStateCache.get(path);
        // Reuse the last parse when the file is byte-identical (same
        // mtime + size + inode) to what produced it — the dominant case
        // on every poll tick once a run goes terminal and stops changing.
        // ino is what actually rules out a false "unchanged" match on a
        // coarse-mtime filesystem (see the field doc comment above).
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.ino === stat.ino) {
          if (cached.state.runId === runId && !byRunId.has(runId)) byRunId.set(runId, cached.state);
          continue;
        }

        let json: string;
        try {
          json = _readFileSync(path, "utf-8");
        } catch (error) {
          fileStateCache.delete(path);
          if (isMissingPathError(error)) continue;
          throw error;
        }
        const parsed = JSON.parse(json) as unknown;
        if (!parsed || typeof parsed !== "object" || !isSafeRunId((parsed as { runId?: unknown }).runId)) {
          fileStateCache.delete(path);
          continue;
        }
        const state = parsed as PersistedRunState;
        if (state.runId !== runId) {
          fileStateCache.delete(path);
          continue;
        }

        // Cache only records that passed both the filename and state.runId
        // checks. Mismatched/unsafe records must never become sticky cache data.
        fileStateCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, state });
        if (!byRunId.has(runId)) byRunId.set(runId, state);
      } catch (error) {
        // Skip syntactically corrupt JSON, but never disguise a permission or
        // other I/O failure as an absent run.
        fileStateCache.delete(path);
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    // Prune cache entries for files that no longer exist (deleted runs) so
    // this map's size tracks what's actually on disk, not lifetime history.
    for (const path of fileStateCache.keys()) {
      if (!seenPaths.has(path)) fileStateCache.delete(path);
    }
    return [...byRunId.values()].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  };

  // Bound the number of terminal (completed/failed/aborted) runs kept on
  // disk (see DEFAULT_MAX_TERMINAL_RUNS_ON_DISK) — called after every save()
  // whose state is terminal, since that's the only time the terminal count
  // can grow. Running/paused runs are never candidates: they're filtered out
  // before the cap is even considered.
  const enforceRetention = () => {
    const terminal = computeList()
      .filter((r) => TERMINAL_RUN_STATUSES.has(r.status))
      .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
    const excess = terminal.length - maxTerminalRunsOnDisk;
    if (excess <= 0) return;
    for (const run of terminal.slice(0, excess)) {
      deleteRunFiles(run.runId);
    }
    invalidateListCache();
  };

  const deleteRunFiles = (runId: string): boolean => {
    const path = primaryRunPath(runId);
    // Clean sidecars alongside the primary. Missing files are benign races;
    // permission and I/O failures remain visible.
    for (const sidecar of [`${path}.bak`, `${path}.tmp`, lockPath(runsDir, runId)]) {
      unlinkIfExistsSafe(fs, sidecar);
      fileStateCache.delete(sidecar);
    }
    const deleted = unlinkIfExistsSafe(fs, path);
    fileStateCache.delete(path);
    return deleted;
  };

  return {
    save(state: PersistedRunState) {
      assertSafeRunId(state.runId);
      ensureDir();
      state.updatedAt = new Date().toISOString();
      const path = primaryRunPath(state.runId);
      // Atomic write: a crash mid-write can't corrupt the live file (tmp+rename is
      // atomic on the same filesystem). A .bak from the previous good save is the
      // recovery fallback if the primary is somehow truncated.
      writeJsonAtomicWithBackup(fs, path, state);
      invalidateListCache();
      // Only a terminal write can grow the terminal-run count, so only check
      // the cap then — a "running"/"paused" save is on the hot path (every
      // progress tick) and must not pay for a retention scan.
      if (TERMINAL_RUN_STATUSES.has(state.status)) enforceRetention();
    },

    load(runId: string): PersistedRunState | null {
      assertSafeRunId(runId);
      enforcePrivateDirectoryModeIfExists(fs, runsDir);
      // Try the primary, then the .bak — so a corrupt primary doesn't lose the run.
      return readRunState(primaryRunPath(runId), runId);
    },

    list(): PersistedRunState[] {
      const now = Date.now();
      // Return a fresh array on every call (a cheap ref-copy) so a caller that
      // sorts/reverses/mutates the result in place can't corrupt the cache — the
      // pre-cache code re-parsed into a new array each call, preserve that.
      if (listCache && now - listCacheAt < LIST_CACHE_TTL_MS) {
        return [...listCache];
      }
      const result = computeList();
      listCache = result;
      listCacheAt = now;
      return [...result];
    },

    delete(runId: string): boolean {
      assertSafeRunId(runId);
      try {
        return deleteRunFiles(runId);
      } finally {
        invalidateListCache();
      }
    },

    acquireRunLease(runId: string): RunLease | null {
      assertSafeRunId(runId);
      ensureDir();
      const path = primaryRunPath(runId);
      const lock = primaryLockPath(runId);
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const payload: LockFile = {
          runId,
          runPath: path,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          token,
        };
        try {
          _writeFileSync(lock, JSON.stringify(payload, null, 2), {
            encoding: "utf8",
            flag: "wx",
            mode: PRIVATE_FILE_MODE,
          });
          enforcePrivateFileMode(fs, lock);
          return { runId, token };
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code !== "EEXIST") throw err;
          const existing = readLock(runId);
          if (existing && existing.runPath === path && pidIsAlive(existing.pid)) {
            return null;
          }
          try {
            _unlinkSync(lock);
          } catch (unlinkError) {
            if (!isMissingPathError(unlinkError)) throw unlinkError;
          }
        }
      }
      return null;
    },

    releaseRunLease(lease: RunLease): void {
      assertSafeRunId(lease.runId);
      const existing = readLock(lease.runId);
      if (existing?.token === lease.token) {
        try {
          _unlinkSync(primaryLockPath(lease.runId));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    },

    getRunsDir(): string {
      return runsDir;
    },
  };
}

/**
 * Generate a unique run ID.
 */
export function generateRunId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${random}`;
}
