/**
 * Workflow logger with file persistence.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  defaultPersistenceFs,
  enforcePrivateFileMode,
  enforcePrivateFileModeIfExists,
  ensureDir,
  PRIVATE_FILE_MODE,
} from "./fs-persistence.js";
import { assertSafeRunId } from "./run-persistence.js";
import { workflowProjectPaths } from "./workflow-paths.js";

export interface WorkflowLogger {
  log(message: string): void;
  error(message: string): void;
  warn(message: string): void;
  getLogs(): string[];
  persist(): string | null;
}

export interface WorkflowLoggerOptions {
  /** Run ID for persistence. */
  runId?: string;
  /** Working directory for file paths. */
  cwd?: string;
  /** Whether to persist logs to disk. */
  persist?: boolean;
  /** Callback for each log entry. */
  onLog?: (message: string) => void;
}

export function createWorkflowLogger(options: WorkflowLoggerOptions = {}): WorkflowLogger {
  const logs: string[] = [];
  const persistLogs = options.persist ?? true;
  const cwd = options.cwd ?? process.cwd();
  const runId = options.runId ?? `run-${Date.now()}`;
  assertSafeRunId(runId);
  const runsDir = workflowProjectPaths(cwd).runsDir;
  const fs = defaultPersistenceFs();
  let logFile: string | null = null;

  const write = (level: string, message: string) => {
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] [${level}] ${message}`;
    logs.push(entry);
    options.onLog?.(message);

    if (persistLogs && logFile) {
      enforcePrivateFileModeIfExists(fs, logFile);
      appendFileSync(logFile, `${entry}\n`, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
      enforcePrivateFileMode(fs, logFile);
    }
  };

  const logger: WorkflowLogger = {
    log(message: string) {
      write("INFO", message);
    },
    error(message: string) {
      write("ERROR", message);
    },
    warn(message: string) {
      write("WARN", message);
    },
    getLogs() {
      return [...logs];
    },
    persist() {
      if (!persistLogs) return null;
      ensureDir(fs, runsDir);
      logFile = join(runsDir, `${runId}.log`);
      enforcePrivateFileModeIfExists(fs, logFile);
      writeFileSync(logFile, `${logs.join("\n")}\n`, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
      enforcePrivateFileMode(fs, logFile);
      return logFile;
    },
  };

  // Initialize log file if persisting
  if (persistLogs) {
    ensureDir(fs, runsDir);
    logFile = join(runsDir, `${runId}.log`);
    enforcePrivateFileModeIfExists(fs, logFile);
  }

  return logger;
}
