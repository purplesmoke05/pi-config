/**
 * Per-agent git worktree isolation. When an agent requests `isolation: "worktree"`,
 * it runs in a throwaway worktree on its own branch so parallel agents can edit the
 * same files without conflict. Results are NOT auto-merged — the path is surfaced for
 * the caller to inspect. Requested isolation is mandatory: setup failure aborts
 * that agent call instead of silently running it in the shared checkout.
 */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface Worktree {
  /** cwd the agent should run in. */
  cwd: string;
  branch: string;
  /** Repo root the worktree was added to (for teardown). */
  repoRoot: string;
}

export class WorktreeIsolationError extends Error {
  readonly code = "worktree_isolation_failed";

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "WorktreeIsolationError";
  }
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "agent"
  );
}

/**
 * Create an isolated worktree under `<repoRoot>/.pi/worktrees/<name>` on branch
 * `pi/wf/<name>`. The `name` must be deterministic (derived from runId + call index,
 * never wall-clock) so resume keys stay stable. Throws when isolation cannot
 * be established; callers must never substitute the shared checkout.
 */
export async function createWorktree(baseCwd: string, name: string): Promise<Worktree> {
  const id = slug(name);
  let repoRoot: string;
  try {
    const { stdout } = await exec("git", ["-C", baseCwd, "rev-parse", "--show-toplevel"]);
    repoRoot = stdout.trim();
  } catch (error) {
    throw new WorktreeIsolationError(`Cannot create an isolated worktree: ${baseCwd} is not a git repository.`, error);
  }

  const path = join(repoRoot, ".pi", "worktrees", id);
  const branch = `pi/wf/${id}`;
  try {
    await exec("git", ["-C", repoRoot, "worktree", "add", "-b", branch, path, "HEAD"]);
    return { cwd: path, branch, repoRoot };
  } catch (error) {
    throw new WorktreeIsolationError(
      `Cannot create isolated worktree ${path}: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

/** Remove a successfully created worktree and its branch. */
export async function removeWorktree(wt: Worktree): Promise<void> {
  try {
    await exec("git", ["-C", wt.repoRoot, "worktree", "remove", "--force", wt.cwd]);
  } catch {
    // already gone / locked — fall through
  }
  try {
    await exec("git", ["-C", wt.repoRoot, "branch", "-D", wt.branch]);
  } catch {
    // branch already deleted
  }
}
