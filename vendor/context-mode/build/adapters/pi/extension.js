var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};

// src/db-base.ts
import { createRequire } from "node:module";
import { existsSync, unlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
function nodeSqliteHasFts5(DatabaseSync) {
  let probe = null;
  try {
    probe = new DatabaseSync(":memory:");
    probe.exec("CREATE VIRTUAL TABLE __fts5_probe USING fts5(x)");
    return true;
  } catch {
    return false;
  } finally {
    try {
      probe?.close();
    } catch {
    }
  }
}
function hasModernSqlite(versionsOverride, bunOverride) {
  const bun = bunOverride !== void 0 ? bunOverride : globalThis.Bun;
  if (typeof bun !== "undefined" && bun !== null) return true;
  const versions = versionsOverride ?? process.versions;
  const [majorStr, minorStr] = (versions.node ?? "0.0.0").split(".");
  const major = Number(majorStr);
  const minor = Number(minorStr);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return major > 22 || major === 22 && minor >= 5;
}
function loadDatabase() {
  if (!_Database) {
    const require2 = createRequire(import.meta.url);
    if (globalThis.Bun) {
      const BunDB = require2(["bun", "sqlite"].join(":")).Database;
      _Database = function BunDatabaseFactory(path, opts) {
        const raw = new BunDB(path, {
          readonly: opts?.readonly,
          create: true
        });
        const adapter = new BunSQLiteAdapter(raw);
        if (opts?.timeout) {
          adapter.pragma(`busy_timeout = ${opts.timeout}`);
        }
        return adapter;
      };
    } else if (hasModernSqlite()) {
      let DatabaseSync = null;
      try {
        ({ DatabaseSync } = require2(["node", "sqlite"].join(":")));
      } catch {
        DatabaseSync = null;
      }
      if (DatabaseSync && nodeSqliteHasFts5(DatabaseSync)) {
        _Database = function NodeDatabaseFactory(path, opts) {
          const raw = new DatabaseSync(path, {
            readOnly: opts?.readonly ?? false
          });
          const adapter = new NodeSQLiteAdapter(raw);
          if (opts?.timeout) {
            adapter.pragma(`busy_timeout = ${opts.timeout}`);
          }
          return adapter;
        };
      } else {
        _Database = require2("better-sqlite3");
      }
    } else {
      _Database = require2("better-sqlite3");
    }
  }
  return _Database;
}
function applyWALPragmas(db) {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  try {
    db.pragma("mmap_size = 268435456");
  } catch {
  }
}
function cleanOrphanedWALFiles(dbPath) {
  if (!existsSync(dbPath)) {
    for (const suffix of ["-wal", "-shm"]) {
      try {
        unlinkSync(dbPath + suffix);
      } catch {
      }
    }
  }
}
function deleteDBFiles(dbPath) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(dbPath + suffix);
    } catch {
    }
  }
}
function closeDB(db) {
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
  }
  try {
    db.close();
  } catch {
  }
}
function defaultDBPath(prefix = "context-mode") {
  return join(tmpdir(), `${prefix}-${process.pid}.db`);
}
function withRetry(fn, delays = [100, 500, 2e3]) {
  let lastError2;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("SQLITE_BUSY") && !msg.includes("database is locked")) {
        throw err;
      }
      lastError2 = err instanceof Error ? err : new Error(msg);
      if (attempt < delays.length) {
        const delay = delays[attempt];
        const start = Date.now();
        while (Date.now() - start < delay) {
        }
      }
    }
  }
  throw new Error(
    `SQLITE_BUSY: database is locked after ${delays.length} retries. Original error: ${lastError2?.message}`
  );
}
function isSQLiteCorruptionError(msg) {
  return msg.includes("SQLITE_CORRUPT") || msg.includes("SQLITE_NOTADB") || msg.includes("database disk image is malformed") || msg.includes("file is not a database");
}
function renameCorruptDB(dbPath) {
  const ts = Date.now();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      renameSync(dbPath + suffix, `${dbPath}${suffix}.corrupt-${ts}`);
    } catch {
    }
  }
}
var BunSQLiteAdapter, NodeSQLiteAdapter, _Database, _kLiveDBs, _liveDBs, SQLiteBase;
var init_db_base = __esm({
  "src/db-base.ts"() {
    "use strict";
    BunSQLiteAdapter = class {
      #raw;
      constructor(rawDb) {
        this.#raw = rawDb;
      }
      pragma(source) {
        const stmt = this.#raw.prepare(`PRAGMA ${source}`);
        const rows = stmt.all();
        if (!rows || rows.length === 0) return void 0;
        if (rows.length > 1) return rows;
        const values = Object.values(rows[0]);
        return values.length === 1 ? values[0] : rows[0];
      }
      exec(sql) {
        let current = "";
        let inString = null;
        for (let i = 0; i < sql.length; i++) {
          const ch = sql[i];
          if (inString) {
            current += ch;
            if (ch === inString) inString = null;
          } else if (ch === "'" || ch === '"') {
            current += ch;
            inString = ch;
          } else if (ch === ";") {
            const trimmed2 = current.trim();
            if (trimmed2) this.#raw.prepare(trimmed2).run();
            current = "";
          } else {
            current += ch;
          }
        }
        const trimmed = current.trim();
        if (trimmed) this.#raw.prepare(trimmed).run();
        return this;
      }
      prepare(sql) {
        const stmt = this.#raw.prepare(sql);
        return {
          run: (...args) => stmt.run(...args),
          get: (...args) => {
            const r = stmt.get(...args);
            return r === null ? void 0 : r;
          },
          all: (...args) => stmt.all(...args),
          iterate: (...args) => stmt.iterate(...args)
        };
      }
      transaction(fn) {
        return this.#raw.transaction(fn);
      }
      close() {
        this.#raw.close();
      }
    };
    NodeSQLiteAdapter = class {
      #raw;
      // DatabaseSync instance
      constructor(rawDb) {
        this.#raw = rawDb;
      }
      pragma(source) {
        const stmt = this.#raw.prepare(`PRAGMA ${source}`);
        const rows = stmt.all();
        if (!rows || rows.length === 0) return void 0;
        if (rows.length > 1) return rows;
        const values = Object.values(rows[0]);
        return values.length === 1 ? values[0] : rows[0];
      }
      exec(sql) {
        this.#raw.exec(sql);
        return this;
      }
      prepare(sql) {
        const stmt = this.#raw.prepare(sql);
        return {
          run: (...args) => stmt.run(...args),
          get: (...args) => stmt.get(...args),
          all: (...args) => stmt.all(...args),
          iterate: (...args) => {
            if (typeof stmt.iterate === "function") {
              return stmt.iterate(...args);
            }
            const rows = stmt.all(...args);
            return rows[Symbol.iterator]();
          }
        };
      }
      transaction(fn) {
        return (...args) => {
          this.#raw.exec("BEGIN");
          try {
            const result = fn(...args);
            this.#raw.exec("COMMIT");
            return result;
          } catch (err) {
            this.#raw.exec("ROLLBACK");
            throw err;
          }
        };
      }
      close() {
        this.#raw.close();
      }
    };
    _Database = null;
    _kLiveDBs = /* @__PURE__ */ Symbol.for("__context_mode_live_dbs_v3__");
    _liveDBs = (() => {
      const g = globalThis;
      if (!g[_kLiveDBs]) {
        g[_kLiveDBs] = /* @__PURE__ */ new Set();
        process.on("exit", () => {
          for (const db of g[_kLiveDBs]) {
            closeDB(db);
          }
          g[_kLiveDBs].clear();
        });
      }
      return g[_kLiveDBs];
    })();
    SQLiteBase = class {
      #dbPath;
      #db;
      /**
       * Open (or create) a SQLite DB at `dbPath`.
       *
       * v1.0.130 — multi-writer is the contract. ALL SQLiteBase consumers
       * (SessionDB, ContentStore) may open the same on-disk dbPath from
       * multiple processes simultaneously — that is the legitimate multi-
       * window UX shape and the WAL handles it natively. SQLITE_BUSY on
       * write contention is absorbed by `withRetry()` below (busy_timeout
       * = 30000ms inside `new Database(...)`).
       *
       * v1.0.128 introduced a single-writer guard here as a defense against
       * #560. That defense was an over-correction — the actual root causes
       * of #560 were #559 (zombie MCP child accumulation) and #561 (Pi
       * misdetection writing to the wrong DB path), both fixed in v1.0.128
       * + v1.0.129. The single-writer guard broke legitimate multi-window
       * users; v1.0.130 rolls it out. See
       * docs/adr/0001-sessiondb-multi-writer.md and the v1.0.130 INVARIANT
       * block in tests/util/db-base-platform-gate.test.ts for the
       * regression-proof anchor (source-pin + behavioural).
       */
      constructor(dbPath) {
        const Database = loadDatabase();
        this.#dbPath = dbPath;
        cleanOrphanedWALFiles(dbPath);
        let db;
        try {
          db = new Database(dbPath, { timeout: 3e4 });
          applyWALPragmas(db);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (isSQLiteCorruptionError(msg)) {
            renameCorruptDB(dbPath);
            cleanOrphanedWALFiles(dbPath);
            try {
              db = new Database(dbPath, { timeout: 3e4 });
              applyWALPragmas(db);
            } catch (retryErr) {
              throw new Error(
                `Failed to create fresh DB after renaming corrupt file: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`
              );
            }
          } else {
            throw err;
          }
        }
        this.#db = db;
        _liveDBs.add(this.#db);
        this.initSchema();
        this.prepareStatements();
      }
      /** Raw database instance — available to subclasses only. */
      get db() {
        return this.#db;
      }
      /** The path this database was opened from. */
      get dbPath() {
        return this.#dbPath;
      }
      /** Close the database connection without deleting files. */
      close() {
        _liveDBs.delete(this.#db);
        closeDB(this.#db);
      }
      withRetry(fn) {
        return withRetry(fn);
      }
      /**
       * Close the connection and delete all associated DB files (main, WAL, SHM).
       * Call on process exit or at end of session lifecycle.
       */
      cleanup() {
        _liveDBs.delete(this.#db);
        closeDB(this.#db);
        deleteDBFiles(this.#dbPath);
      }
    };
  }
});

// src/credential-env.ts
function isSensitiveEnvironmentName(name) {
  return /(?:^|_)(?:API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|AUTH(?:ORIZATION)?|BEARER|COOKIE|PAT|JWT|DATABASE_URL|DB_URL|CONNECTION_STRING)(?:_|$)/i.test(name) || /^(?:PGPASSWORD|PGPASSFILE|MYSQL_PWD|REDISCLI_AUTH|KUBECONFIG)$/i.test(name) || /^(?:(?:HTTP|HTTPS|ALL)_PROXY|NPM_CONFIG_(?:PROXY|HTTPS_PROXY))$/i.test(name);
}
function isUnsafeChildEnvironmentName(name) {
  const upper = name.toUpperCase();
  return isSensitiveEnvironmentName(name) || UNSAFE_CHILD_ENVIRONMENT_NAMES.has(upper) || upper.startsWith("BASH_FUNC_") || upper.startsWith("COMPLUS_");
}
function safeChildProcessEnvironment(source = process.env) {
  return Object.fromEntries(
    Object.entries(source).filter(
      (entry) => entry[1] !== void 0 && !isUnsafeChildEnvironmentName(entry[0])
    )
  );
}
var UNSAFE_CHILD_ENVIRONMENT_NAMES;
var init_credential_env = __esm({
  "src/credential-env.ts"() {
    "use strict";
    UNSAFE_CHILD_ENVIRONMENT_NAMES = /* @__PURE__ */ new Set([
      "BASH_ENV",
      "ENV",
      "PROMPT_COMMAND",
      "PS4",
      "SHELLOPTS",
      "BASHOPTS",
      "CDPATH",
      "INPUTRC",
      "BASH_XTRACEFD",
      "NODE_OPTIONS",
      "NODE_PATH",
      "PYTHONSTARTUP",
      "PYTHONHOME",
      "PYTHONWARNINGS",
      "PYTHONBREAKPOINT",
      "PYTHONINSPECT",
      "RUBYOPT",
      "RUBYLIB",
      "PERL5OPT",
      "PERL5LIB",
      "PERLLIB",
      "PERL5DB",
      "ERL_AFLAGS",
      "ERL_FLAGS",
      "ELIXIR_ERL_OPTIONS",
      "ERL_LIBS",
      "GOFLAGS",
      "CGO_CFLAGS",
      "CGO_LDFLAGS",
      "RUSTC",
      "RUSTC_WRAPPER",
      "RUSTC_WORKSPACE_WRAPPER",
      "CARGO_BUILD_RUSTC",
      "CARGO_BUILD_RUSTC_WRAPPER",
      "RUSTFLAGS",
      "PHPRC",
      "PHP_INI_SCAN_DIR",
      "R_PROFILE",
      "R_PROFILE_USER",
      "R_HOME",
      "DOTNET_STARTUP_HOOKS",
      "DOTNET_ADDITIONAL_DEPS",
      "DOTNET_SHARED_STORE",
      "DOTNET_ROOT",
      "DOTNET_ROOT(X86)",
      "DOTNET_HOST_PATH",
      "CORECLR_PROFILER",
      "CORECLR_PROFILER_PATH",
      "CORECLR_PROFILER_PATH_32",
      "CORECLR_PROFILER_PATH_64",
      "CORECLR_PROFILER_PATH_ARM32",
      "CORECLR_PROFILER_PATH_ARM64",
      "CORECLR_ENABLE_PROFILING",
      "DOTNET_PROFILER_PATH",
      "DOTNET_PROFILER_PATH_32",
      "DOTNET_PROFILER_PATH_64",
      "DOTNET_PROFILER_PATH_ARM32",
      "DOTNET_PROFILER_PATH_ARM64",
      "DOTNET_DIAGNOSTICPORTS",
      "DOTNET_BUNDLE_EXTRACT_BASE_DIR",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "DYLD_INSERT_LIBRARIES",
      "DYLD_LIBRARY_PATH",
      "OPENSSL_CONF",
      "OPENSSL_ENGINES",
      "CC",
      "CXX",
      "AR",
      "GIT_TEMPLATE_DIR",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_SYSTEM",
      "GIT_EXEC_PATH",
      "GIT_SSH",
      "GIT_SSH_COMMAND",
      "GIT_ASKPASS",
      "SSH_ASKPASS"
    ]);
  }
});

// src/session/db.ts
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync as existsSync2, mkdirSync, realpathSync, renameSync as renameSync2 } from "node:fs";
import { dirname, isAbsolute, join as join2, resolve } from "node:path";
function normalizeWorktreePath(path) {
  const normalized = path.replace(/\\/g, "/");
  if (/^\/+$/.test(normalized)) return "/";
  if (/^[A-Za-z]:\/+$/.test(normalized)) return `${normalized.slice(0, 2)}/`;
  return normalized.replace(/\/+$/, "");
}
function canonicalizeForCompare(root) {
  let resolved = root;
  try {
    resolved = realpathSync.native(root);
  } catch {
  }
  const normalized = normalizeWorktreePath(resolved);
  if (process.platform === "win32" || process.platform === "darwin") {
    return normalized.toLowerCase();
  }
  return normalized;
}
function gitOutput(projectDir, args) {
  return execFileSync(
    "git",
    ["-C", projectDir, ...args],
    {
      encoding: "utf-8",
      timeout: 2e3,
      stdio: ["ignore", "pipe", "ignore"],
      env: safeChildProcessEnvironment()
    }
  ).trim();
}
function getCurrentWorktreeRoot(projectDir) {
  const root = gitOutput(projectDir, ["rev-parse", "--show-toplevel"]);
  return root.length > 0 ? normalizeWorktreePath(root) : null;
}
function getMainWorktreeRoot(projectDir) {
  const root = gitOutput(projectDir, ["worktree", "list", "--porcelain"]).split(/\r?\n/).find((line) => line.startsWith("worktree "))?.replace("worktree ", "")?.trim();
  return root ? normalizeWorktreePath(root) : null;
}
function getWorktreeSuffix(projectDir = process.cwd()) {
  const envSuffix = process.env.CONTEXT_MODE_SESSION_SUFFIX;
  if (_wtCache && _wtCache.projectDir === projectDir && _wtCache.envSuffix === envSuffix) {
    return _wtCache.suffix;
  }
  let suffix = "";
  if (envSuffix !== void 0) {
    suffix = envSuffix ? `__${envSuffix}` : "";
  } else {
    try {
      const currentRoot = getCurrentWorktreeRoot(projectDir);
      const mainRoot = getMainWorktreeRoot(projectDir);
      if (currentRoot && mainRoot) {
        const canonicalCurrent = canonicalizeForCompare(currentRoot);
        const canonicalMain = canonicalizeForCompare(mainRoot);
        if (canonicalCurrent !== canonicalMain) {
          suffix = `__${createHash("sha256").update(canonicalCurrent).digest("hex").slice(0, 8)}`;
        }
      }
    } catch {
    }
  }
  _wtCache = { projectDir, envSuffix, suffix };
  return suffix;
}
function hashProjectDirLegacy(projectDir) {
  return createHash("sha256").update(normalizeWorktreePath(projectDir)).digest("hex").slice(0, 16);
}
function hashProjectDirCanonical(projectDir) {
  const normalized = normalizeWorktreePath(projectDir);
  const folded = process.platform === "darwin" || process.platform === "win32" ? normalized.toLowerCase() : normalized;
  return createHash("sha256").update(folded).digest("hex").slice(0, 16);
}
function resolveSessionDbPath(opts) {
  return resolveSessionPath({ ...opts, ext: ".db" });
}
function resolveSessionPath(opts) {
  const { projectDir, sessionsDir, ext } = opts;
  const suffix = opts.suffix ?? getWorktreeSuffix(projectDir);
  const canonicalHash = hashProjectDirCanonical(projectDir);
  const canonicalPath = join2(sessionsDir, `${canonicalHash}${suffix}${ext}`);
  if (existsSync2(canonicalPath)) return canonicalPath;
  const legacyHash = hashProjectDirLegacy(projectDir);
  if (legacyHash === canonicalHash) return canonicalPath;
  const legacyPath = join2(sessionsDir, `${legacyHash}${suffix}${ext}`);
  if (existsSync2(legacyPath)) {
    try {
      renameSync2(legacyPath, canonicalPath);
    } catch {
    }
  }
  return canonicalPath;
}
function clampNonNegativeInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}
function applyMissingSessionEventsColumns(db) {
  const colInfo = db.pragma("table_xinfo(session_events)");
  const cols = new Set(colInfo.map((c) => c.name));
  let changed = false;
  for (const [name, spec] of SESSION_EVENTS_REQUIRED_COLUMNS) {
    if (!cols.has(name)) {
      db.exec(`ALTER TABLE session_events ADD COLUMN ${name} ${spec}`);
      changed = true;
    }
  }
  if (changed) {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_session_events_project ON session_events(session_id, project_dir)"
    );
  }
  return changed;
}
var _wtCache, MAX_EVENTS_PER_SESSION, DEDUP_WINDOW, S, SESSION_EVENTS_REQUIRED_COLUMNS, SessionDB;
var init_db = __esm({
  "src/session/db.ts"() {
    "use strict";
    init_db_base();
    init_credential_env();
    MAX_EVENTS_PER_SESSION = 1e3;
    DEDUP_WINDOW = 5;
    S = {
      insertEvent: "insertEvent",
      getEvents: "getEvents",
      getEventsByType: "getEventsByType",
      getEventsByPriority: "getEventsByPriority",
      getEventsByTypeAndPriority: "getEventsByTypeAndPriority",
      getEventCount: "getEventCount",
      getLatestAttributedProject: "getLatestAttributedProject",
      checkDuplicate: "checkDuplicate",
      evictLowestPriority: "evictLowestPriority",
      updateMetaLastEvent: "updateMetaLastEvent",
      ensureSession: "ensureSession",
      getSessionStats: "getSessionStats",
      getSessionRollup: "getSessionRollup",
      getMaxFileEdits: "getMaxFileEdits",
      getLatestCommitMessage: "getLatestCommitMessage",
      incrementCompactCount: "incrementCompactCount",
      getUsageCursor: "getUsageCursor",
      setUsageCursor: "setUsageCursor",
      upsertResume: "upsertResume",
      getResume: "getResume",
      markResumeConsumed: "markResumeConsumed",
      claimLatestUnconsumedResume: "claimLatestUnconsumedResume",
      deleteEvents: "deleteEvents",
      deleteMeta: "deleteMeta",
      deleteResume: "deleteResume",
      getOldSessions: "getOldSessions",
      searchEvents: "searchEvents",
      incrementToolCall: "incrementToolCall",
      getToolCallTotals: "getToolCallTotals",
      getToolCallByTool: "getToolCallByTool",
      getEventBytesSummary: "getEventBytesSummary"
    };
    SESSION_EVENTS_REQUIRED_COLUMNS = [
      ["project_dir", "TEXT NOT NULL DEFAULT ''"],
      ["attribution_source", "TEXT NOT NULL DEFAULT 'unknown'"],
      ["attribution_confidence", "REAL NOT NULL DEFAULT 0"],
      ["bytes_avoided", "INTEGER NOT NULL DEFAULT 0"],
      ["bytes_returned", "INTEGER NOT NULL DEFAULT 0"]
    ];
    SessionDB = class extends SQLiteBase {
      constructor(opts) {
        super(opts?.dbPath ?? defaultDBPath("session"));
      }
      /** Shorthand to retrieve a cached statement. */
      stmt(key) {
        return this.stmts.get(key);
      }
      // ── Schema ──
      initSchema() {
        try {
          const colInfo = this.db.pragma("table_xinfo(session_events)");
          const hashCol = colInfo.find((c) => c.name === "data_hash");
          if (hashCol && hashCol.hidden !== 0) {
            this.db.exec("DROP TABLE session_events");
          }
        } catch {
        }
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        category TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 2,
        data TEXT NOT NULL,
        project_dir TEXT NOT NULL DEFAULT '',
        attribution_source TEXT NOT NULL DEFAULT 'unknown',
        attribution_confidence REAL NOT NULL DEFAULT 0,
        bytes_avoided INTEGER NOT NULL DEFAULT 0,
        bytes_returned INTEGER NOT NULL DEFAULT 0,
        source_hook TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        data_hash TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(session_id, type);
      CREATE INDEX IF NOT EXISTS idx_session_events_priority ON session_events(session_id, priority);

      CREATE TABLE IF NOT EXISTS session_meta (
        session_id TEXT PRIMARY KEY,
        project_dir TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_event_at TEXT,
        event_count INTEGER NOT NULL DEFAULT 0,
        compact_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS session_resume (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL UNIQUE,
        snapshot TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        consumed INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS tool_calls (
        session_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        calls INTEGER NOT NULL DEFAULT 0,
        bytes_returned INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, tool)
      );

      CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
    `);
        try {
          applyMissingSessionEventsColumns(this.db);
        } catch {
        }
        try {
          const metaCols = this.db.pragma("table_xinfo(session_meta)");
          if (!metaCols.some((c) => c.name === "usage_cursor")) {
            this.db.exec("ALTER TABLE session_meta ADD COLUMN usage_cursor TEXT");
          }
        } catch {
        }
      }
      prepareStatements() {
        this.stmts = /* @__PURE__ */ new Map();
        const p = (key, sql) => {
          this.stmts.set(key, this.db.prepare(sql));
        };
        p(
          S.insertEvent,
          `INSERT INTO session_events (
         session_id, type, category, priority, data,
         project_dir, attribution_source, attribution_confidence,
         bytes_avoided, bytes_returned,
         source_hook, data_hash
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        p(
          S.getEvents,
          `SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              bytes_avoided, bytes_returned,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? ORDER BY id ASC LIMIT ?`
        );
        p(
          S.getEventsByType,
          `SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              bytes_avoided, bytes_returned,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND type = ? ORDER BY id ASC LIMIT ?`
        );
        p(
          S.getEventsByPriority,
          `SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              bytes_avoided, bytes_returned,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND priority >= ? ORDER BY id ASC LIMIT ?`
        );
        p(
          S.getEventsByTypeAndPriority,
          `SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              bytes_avoided, bytes_returned,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND type = ? AND priority >= ? ORDER BY id ASC LIMIT ?`
        );
        p(
          S.getEventCount,
          `SELECT COUNT(*) AS cnt FROM session_events WHERE session_id = ?`
        );
        p(
          S.getLatestAttributedProject,
          `SELECT project_dir
       FROM session_events
       WHERE session_id = ? AND project_dir != ''
       ORDER BY id DESC
       LIMIT 1`
        );
        p(
          S.checkDuplicate,
          `SELECT 1 FROM (
         SELECT type, data_hash FROM session_events
         WHERE session_id = ? ORDER BY id DESC LIMIT ?
       ) AS recent
       WHERE recent.type = ? AND recent.data_hash = ?
       LIMIT 1`
        );
        p(
          S.evictLowestPriority,
          `DELETE FROM session_events WHERE id = (
         SELECT id FROM session_events WHERE session_id = ?
         ORDER BY priority ASC, id ASC LIMIT 1
       )`
        );
        p(
          S.updateMetaLastEvent,
          `UPDATE session_meta
       SET last_event_at = datetime('now'), event_count = event_count + 1
       WHERE session_id = ?`
        );
        p(
          S.ensureSession,
          `INSERT OR IGNORE INTO session_meta (session_id, project_dir) VALUES (?, ?)`
        );
        p(
          S.getSessionStats,
          `SELECT session_id, project_dir, started_at, last_event_at, event_count, compact_count
       FROM session_meta WHERE session_id = ?`
        );
        p(
          S.getSessionRollup,
          `SELECT
         COUNT(*) AS tool_calls,
         COALESCE(SUM(CASE WHEN category = 'error' THEN 1 ELSE 0 END), 0) AS errors,
         COUNT(DISTINCT type) AS unique_tools,
         COUNT(DISTINCT CASE WHEN category = 'file' THEN data END) AS unique_files,
         CASE WHEN SUM(CASE WHEN type = 'git_commit' THEN 1 ELSE 0 END) > 0 THEN 1 ELSE 0 END AS has_commit,
         CAST(COALESCE((MAX(strftime('%s', created_at)) - MIN(strftime('%s', created_at))) / 60.0, 0) AS INTEGER) AS duration_min,
         COALESCE(SUM(CASE WHEN type = 'external_ref' THEN 1 ELSE 0 END), 0) AS sources_indexed,
         CAST(COALESCE(SUM(bytes_avoided) / 1024.0, 0) AS INTEGER) AS total_chunks,
         COALESCE(SUM(CASE WHEN type IN ('file_search', 'file_glob') THEN 1 ELSE 0 END), 0) AS search_queries
       FROM session_events
       WHERE session_id = ?`
        );
        p(
          S.getMaxFileEdits,
          `SELECT COALESCE(MAX(c), 0) AS max_file_edits
       FROM (
         SELECT COUNT(*) AS c
         FROM session_events
         WHERE session_id = ? AND category = 'file' AND type IN ('file_edit', 'file_write')
         GROUP BY data
       )`
        );
        p(
          S.getLatestCommitMessage,
          `SELECT data
       FROM session_events
       WHERE session_id = ? AND type = 'git_commit'
       ORDER BY id DESC
       LIMIT 1`
        );
        p(
          S.incrementCompactCount,
          `UPDATE session_meta SET compact_count = compact_count + 1 WHERE session_id = ?`
        );
        p(
          S.getUsageCursor,
          `SELECT usage_cursor FROM session_meta WHERE session_id = ?`
        );
        p(
          S.setUsageCursor,
          `UPDATE session_meta SET usage_cursor = ? WHERE session_id = ?`
        );
        p(
          S.upsertResume,
          `INSERT INTO session_resume (session_id, snapshot, event_count)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         snapshot = excluded.snapshot,
         event_count = excluded.event_count,
         created_at = datetime('now'),
         consumed = 0`
        );
        p(
          S.getResume,
          `SELECT snapshot, event_count, consumed FROM session_resume WHERE session_id = ?`
        );
        p(
          S.markResumeConsumed,
          `UPDATE session_resume SET consumed = 1 WHERE session_id = ?`
        );
        p(
          S.claimLatestUnconsumedResume,
          `UPDATE session_resume
       SET consumed = 1
       WHERE id = (
         SELECT id FROM session_resume
         WHERE consumed = 0
           AND session_id != ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       )
       RETURNING session_id, snapshot`
        );
        p(S.deleteEvents, `DELETE FROM session_events WHERE session_id = ?`);
        p(S.deleteMeta, `DELETE FROM session_meta WHERE session_id = ?`);
        p(S.deleteResume, `DELETE FROM session_resume WHERE session_id = ?`);
        p(
          S.searchEvents,
          `SELECT id, session_id, category, type, data, created_at
       FROM session_events
       WHERE (project_dir = ? OR project_dir = '')
         AND (data LIKE '%' || ? || '%' ESCAPE '\\' OR category LIKE '%' || ? || '%' ESCAPE '\\')
         AND (? IS NULL OR category = ?)
       ORDER BY id ASC
       LIMIT ?`
        );
        p(
          S.getOldSessions,
          `SELECT session_id FROM session_meta WHERE started_at < datetime('now', ? || ' days')`
        );
        p(
          S.incrementToolCall,
          `INSERT INTO tool_calls (session_id, tool, calls, bytes_returned)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(session_id, tool) DO UPDATE SET
         calls = calls + 1,
         bytes_returned = bytes_returned + excluded.bytes_returned,
         updated_at = datetime('now')`
        );
        p(
          S.getToolCallTotals,
          `SELECT COALESCE(SUM(calls), 0) AS calls,
              COALESCE(SUM(bytes_returned), 0) AS bytes_returned
       FROM tool_calls WHERE session_id = ?`
        );
        p(
          S.getToolCallByTool,
          `SELECT tool, calls, bytes_returned
       FROM tool_calls WHERE session_id = ? ORDER BY calls DESC`
        );
        p(
          S.getEventBytesSummary,
          `SELECT COALESCE(SUM(bytes_avoided), 0) AS bytes_avoided,
              COALESCE(SUM(bytes_returned), 0) AS bytes_returned
       FROM session_events WHERE session_id = ?`
        );
      }
      // ═══════════════════════════════════════════
      // Events
      // ═══════════════════════════════════════════
      /**
       * Insert a session event with deduplication and FIFO eviction.
       *
       * Deduplication: skips if the same type + data_hash appears in the
       * last DEDUP_WINDOW events for this session.
       *
       * Eviction: if session exceeds MAX_EVENTS_PER_SESSION, evicts the
       * lowest-priority (then oldest) event.
       */
      insertEvent(sessionId, event, sourceHook = "PostToolUse", attribution, bytes) {
        const dataHash = createHash("sha256").update(event.data).digest("hex").slice(0, 16).toUpperCase();
        const projectDir = String(
          attribution?.projectDir ?? event.project_dir ?? this._getSessionProjectDir(sessionId)
        ).trim();
        const attributionSource = String(
          attribution?.source ?? event.attribution_source ?? "unknown"
        );
        const rawConfidence = Number(
          attribution?.confidence ?? event.attribution_confidence ?? 0
        );
        const attributionConfidence = Number.isFinite(rawConfidence) ? Math.max(0, Math.min(1, rawConfidence)) : 0;
        const bytesAvoided = clampNonNegativeInt(bytes?.bytesAvoided);
        const bytesReturned = clampNonNegativeInt(bytes?.bytesReturned);
        const transaction = this.db.transaction(() => {
          const dup = this.stmt(S.checkDuplicate).get(sessionId, DEDUP_WINDOW, event.type, dataHash);
          if (dup) return;
          const countRow = this.stmt(S.getEventCount).get(sessionId);
          if (countRow.cnt >= MAX_EVENTS_PER_SESSION) {
            this.stmt(S.evictLowestPriority).run(sessionId);
          }
          this.stmt(S.insertEvent).run(
            sessionId,
            event.type,
            event.category,
            event.priority,
            event.data,
            projectDir,
            attributionSource,
            attributionConfidence,
            bytesAvoided,
            bytesReturned,
            sourceHook,
            dataHash
          );
          this.stmt(S.updateMetaLastEvent).run(sessionId);
        });
        this.withRetry(() => transaction());
      }
      /**
       * Bulk-insert N events in a SINGLE transaction.
       *
       * PostToolUse hooks emit 5–15 events per tool call. Calling insertEvent()
       * in a loop runs N transactions = N WAL commits = N fsync candidates,
       * which is painful on Windows NTFS where commit latency dominates.
       * One transaction = one commit, dedup/evict checks reuse cached statements.
       *
       * Cross-platform: uses the same WAL-mode transaction primitive as
       * insertEvent — behavior identical on macOS / Linux / Windows.
       */
      bulkInsertEvents(sessionId, events, sourceHook = "PostToolUse", attributions, bytesList) {
        if (!events || events.length === 0) return;
        if (events.length === 1) {
          this.insertEvent(sessionId, events[0], sourceHook, attributions?.[0], bytesList?.[0]);
          return;
        }
        const prepared = events.map((event, i) => {
          const dataHash = createHash("sha256").update(event.data).digest("hex").slice(0, 16).toUpperCase();
          const attribution = attributions?.[i];
          const rawProjectDir = String(
            attribution?.projectDir ?? event.project_dir ?? this._getSessionProjectDir(sessionId) ?? ""
          ).trim();
          const projectDir = rawProjectDir === "" ? "" : normalizeWorktreePath(rawProjectDir);
          const attributionSource = String(
            attribution?.source ?? event.attribution_source ?? "unknown"
          );
          const rawConfidence = Number(
            attribution?.confidence ?? event.attribution_confidence ?? 0
          );
          const attributionConfidence = Number.isFinite(rawConfidence) ? Math.max(0, Math.min(1, rawConfidence)) : 0;
          const eventBytes = bytesList?.[i];
          const bytesAvoided = clampNonNegativeInt(eventBytes?.bytesAvoided);
          const bytesReturned = clampNonNegativeInt(eventBytes?.bytesReturned);
          return {
            event,
            dataHash,
            projectDir,
            attributionSource,
            attributionConfidence,
            bytesAvoided,
            bytesReturned
          };
        });
        const transaction = this.db.transaction(() => {
          let cnt = this.stmt(S.getEventCount).get(sessionId).cnt;
          for (const row of prepared) {
            const dup = this.stmt(S.checkDuplicate).get(
              sessionId,
              DEDUP_WINDOW,
              row.event.type,
              row.dataHash
            );
            if (dup) continue;
            if (cnt >= MAX_EVENTS_PER_SESSION) {
              this.stmt(S.evictLowestPriority).run(sessionId);
            } else {
              cnt++;
            }
            this.stmt(S.insertEvent).run(
              sessionId,
              row.event.type,
              row.event.category,
              row.event.priority,
              row.event.data,
              row.projectDir,
              row.attributionSource,
              row.attributionConfidence,
              row.bytesAvoided,
              row.bytesReturned,
              sourceHook,
              row.dataHash
            );
          }
          this.stmt(S.updateMetaLastEvent).run(sessionId);
        });
        this.withRetry(() => transaction());
      }
      /**
       * Retrieve events for a session with optional filtering.
       */
      getEvents(sessionId, opts) {
        const limit = opts?.limit ?? 1e3;
        const type = opts?.type;
        const minPriority = opts?.minPriority;
        if (type && minPriority !== void 0) {
          return this.stmt(S.getEventsByTypeAndPriority).all(sessionId, type, minPriority, limit);
        }
        if (type) {
          return this.stmt(S.getEventsByType).all(sessionId, type, limit);
        }
        if (minPriority !== void 0) {
          return this.stmt(S.getEventsByPriority).all(sessionId, minPriority, limit);
        }
        return this.stmt(S.getEvents).all(sessionId, limit);
      }
      /**
       * Get the total event count for a session.
       */
      getEventCount(sessionId) {
        const row = this.stmt(S.getEventCount).get(sessionId);
        return row.cnt;
      }
      /**
       * Aggregate per-event byte accounting for a session.
       *
       * Returns the total bytes context-mode kept OUT of the model context
       * window (`bytesAvoided`) and the total it actually returned to the
       * model (`bytesReturned`). Both default to 0 for unknown sessions.
       *
       * Used by the Insight dashboard to render the "saved vs returned"
       * panel without scanning every event row in JS.
       */
      getEventBytesSummary(sessionId) {
        const row = this.stmt(S.getEventBytesSummary).get(sessionId);
        return {
          bytesAvoided: Number(row?.bytes_avoided ?? 0),
          bytesReturned: Number(row?.bytes_returned ?? 0)
        };
      }
      /**
       * Return the most recently attributed project dir for a session.
       */
      getLatestAttributedProjectDir(sessionId) {
        const row = this.stmt(S.getLatestAttributedProject).get(sessionId);
        return row?.project_dir || null;
      }
      /**
       * Look up the project_dir from session_meta as a last-resort fallback
       * for event attribution. Prevents project_dir='' orphans when the caller
       * (e.g. pi adapter) omits the attribution parameter.
       */
      _getSessionProjectDir(sessionId) {
        try {
          const row = this.db.prepare("SELECT project_dir FROM session_meta WHERE session_id = ?").get(sessionId);
          return row?.project_dir || "";
        } catch {
          return "";
        }
      }
      /**
       * Search events by text query scoped to a project directory.
       *
       * Performs a case-insensitive LIKE search across the `data` and `category`
       * columns. An optional `source` parameter filters by exact category match.
       * Returns results ordered by monotonic id (chronological).
       *
       * Best-effort: returns empty array on any error.
       */
      searchEvents(query, limit, projectDir, source) {
        try {
          const escapedQuery = query.replace(/[%_]/g, (char) => "\\" + char);
          const sourceParam = source ?? null;
          return this.stmt(S.searchEvents).all(
            projectDir,
            escapedQuery,
            escapedQuery,
            sourceParam,
            sourceParam,
            limit
          );
        } catch {
          return [];
        }
      }
      /**
       * Return the distinct list of session ids whose events were attributed
       * to a given `project_dir`. Powers the ctx_search `project:` filter
       * (#737) via the 2-step IN-clause strategy — ATTACH DATABASE is avoided
       * because SQLite's WAL + ATTACH combination has known correctness
       * trade-offs flagged in the upstream docs.
       *
       * Backed by the `idx_session_events_project(session_id, project_dir)`
       * composite index, so 1000-session lookups complete in single-digit
       * milliseconds. Best-effort: returns `[]` on any error.
       */
      getSessionIdsForProject(projectDir) {
        try {
          const normalized = normalizeWorktreePath(projectDir);
          const rows = this.db.prepare(
            `SELECT DISTINCT session_id
             FROM session_events
            WHERE RTRIM(REPLACE(project_dir, '\\', '/'), '/') = ?`
          ).all(normalized);
          return rows.map((r) => r.session_id);
        } catch {
          return [];
        }
      }
      // ═══════════════════════════════════════════
      // Meta
      // ═══════════════════════════════════════════
      /**
       * Ensure a session metadata entry exists. Idempotent (INSERT OR IGNORE).
       * `projectDir` is the session origin directory, not per-event attribution.
       */
      ensureSession(sessionId, projectDir) {
        this.stmt(S.ensureSession).run(sessionId, projectDir);
      }
      /**
       * Get session statistics/metadata.
       */
      getSessionStats(sessionId) {
        const row = this.stmt(S.getSessionStats).get(sessionId);
        return row ?? null;
      }
      /**
       * Session rollup snapshot — 12 aggregate fields the analytics platform
       * stamps onto every outgoing event row (seed.ts shape parity).
       *
       * Called from session-loaders BEFORE `maybeForward`; the snapshot is
       * computed against the LOCAL SessionDB and threaded into the canonical
       * event so the platform-side Zod schema receives the rich shape without
       * the bridge ever hand-mapping fields (PRD §5.4 ABI passthrough).
       *
       * Returns zeroed defaults for unknown sessions — callers MUST tolerate
       * a snapshot from an empty session (first event into a fresh DB).
       */
      getSessionRollup(sessionId) {
        const main = this.stmt(S.getSessionRollup).get(sessionId);
        const maxRow = this.stmt(S.getMaxFileEdits).get(sessionId);
        const commitRow = this.stmt(S.getLatestCommitMessage).get(sessionId);
        const meta = this.getSessionStats(sessionId);
        const fileEdits = (main?.tool_calls ?? 0) > 0 ? main?.unique_files ?? 0 : 0;
        const errors = main?.errors ?? 0;
        const editTestCycles = Math.min(fileEdits, errors);
        return {
          tool_calls: main?.tool_calls ?? 0,
          errors: main?.errors ?? 0,
          unique_tools: main?.unique_tools ?? 0,
          unique_files: main?.unique_files ?? 0,
          max_file_edits: maxRow?.max_file_edits ?? 0,
          has_commit: main?.has_commit ?? 0,
          commit_message: commitRow?.data ?? "",
          edit_test_cycles: editTestCycles,
          duration_min: main?.duration_min ?? 0,
          compact_count: meta?.compact_count ?? 0,
          sources_indexed: main?.sources_indexed ?? 0,
          total_chunks: main?.total_chunks ?? 0,
          search_queries: main?.search_queries ?? 0
        };
      }
      /**
       * Increment the compact_count for a session (tracks snapshot rebuilds).
       */
      incrementCompactCount(sessionId) {
        this.stmt(S.incrementCompactCount).run(sessionId);
      }
      /**
       * Read the per-session usage high-water cursor — the uuid of the last
       * assistant turn already emitted by the Stop hook's main-turn capture.
       * Returns null when unset (first Stop) or the session row is absent.
       */
      getUsageCursor(sessionId) {
        const row = this.stmt(S.getUsageCursor).get(sessionId);
        return row?.usage_cursor ?? null;
      }
      /**
       * Advance the per-session usage high-water cursor to `uuid`. No-op when the
       * session_meta row does not exist yet (callers ensureSession first).
       */
      setUsageCursor(sessionId, uuid) {
        this.stmt(S.setUsageCursor).run(uuid, sessionId);
      }
      // ═══════════════════════════════════════════
      // Resume
      // ═══════════════════════════════════════════
      /**
       * Upsert a resume snapshot for a session. Resets consumed flag on update.
       */
      upsertResume(sessionId, snapshot, eventCount) {
        this.stmt(S.upsertResume).run(sessionId, snapshot, eventCount ?? 0);
      }
      /**
       * Retrieve the resume snapshot for a session.
       */
      getResume(sessionId) {
        const row = this.stmt(S.getResume).get(sessionId);
        return row ?? null;
      }
      /**
       * Mark the resume snapshot as consumed (already injected into conversation).
       */
      markResumeConsumed(sessionId) {
        this.stmt(S.markResumeConsumed).run(sessionId);
      }
      /**
       * Atomically claim the most recent unconsumed resume snapshot in this DB,
       * EXCLUDING any row that belongs to `currentSessionId`.
       *
       * `SessionDB` is sharded per project (see `resolveSessionDbPath` — SHA-256
       * of canonical project dir), so "this DB" already implies "this project".
       * The atomic
       * `UPDATE … RETURNING` ensures concurrent processes for the same project
       * cannot both inject the same snapshot (Mickey / PR #376 race).
       *
       * The `currentSessionId` parameter prevents self-injection: when a session
       * compacts mid-flight and produces its own row, that session's next chat
       * turn must NOT claim that row back (wasted tokens AND it would consume
       * the snapshot meant for the next fresh session).
       *
       * Pass an empty string to allow self-claim (legacy behaviour, only useful
       * in tests or one-off harnesses).
       *
       * Returns null when no unconsumed snapshot exists for any other session.
       */
      claimLatestUnconsumedResume(currentSessionId) {
        const row = this.stmt(S.claimLatestUnconsumedResume).get(currentSessionId);
        if (!row) return null;
        return { sessionId: row.session_id, snapshot: row.snapshot };
      }
      /**
       * Return the most recent session_id from session_meta, or null if none.
       * Used by the runtime to attach persistent counters to the right session
       * after a process restart.
       */
      getLatestSessionId() {
        try {
          const row = this.db.prepare(
            "SELECT session_id FROM session_meta ORDER BY started_at DESC LIMIT 1"
          ).get();
          return row?.session_id ?? null;
        } catch {
          return null;
        }
      }
      // ═══════════════════════════════════════════
      // Tool call counters (Bug #1 + #2 — survive restart, --continue, upgrade)
      // ═══════════════════════════════════════════
      /**
       * Increment the persistent tool-call counter for `tool` in `sessionId`.
       * Adds `bytesReturned` to the cumulative total. Idempotent across
       * SessionDB instances — counters survive process restart.
       */
      incrementToolCall(sessionId, tool, bytesReturned = 0) {
        const safeBytes = Number.isFinite(bytesReturned) && bytesReturned > 0 ? Math.round(bytesReturned) : 0;
        try {
          this.stmt(S.incrementToolCall).run(sessionId, tool, safeBytes);
        } catch {
        }
      }
      /**
       * Get aggregated tool-call stats for `sessionId`. Returns zero-stats
       * when the session has no recorded calls.
       */
      getToolCallStats(sessionId) {
        try {
          const totals = this.stmt(S.getToolCallTotals).get(sessionId);
          const rows = this.stmt(S.getToolCallByTool).all(sessionId);
          const byTool = {};
          for (const row of rows) {
            byTool[row.tool] = {
              calls: row.calls,
              bytesReturned: row.bytes_returned
            };
          }
          return {
            totalCalls: totals?.calls ?? 0,
            totalBytesReturned: totals?.bytes_returned ?? 0,
            byTool
          };
        } catch {
          return { totalCalls: 0, totalBytesReturned: 0, byTool: {} };
        }
      }
      // ═══════════════════════════════════════════
      // Lifecycle
      // ═══════════════════════════════════════════
      /**
       * Delete all data for a session (events, meta, resume).
       */
      deleteSession(sessionId) {
        this.db.transaction(() => {
          this.stmt(S.deleteEvents).run(sessionId);
          this.stmt(S.deleteResume).run(sessionId);
          this.stmt(S.deleteMeta).run(sessionId);
        })();
      }
      /**
       * Remove sessions older than maxAgeDays. Returns the count of deleted sessions.
       */
      cleanupOldSessions(maxAgeDays = 7) {
        const negDays = `-${maxAgeDays}`;
        const oldSessions = this.stmt(S.getOldSessions).all(negDays);
        for (const { session_id } of oldSessions) {
          this.deleteSession(session_id);
        }
        return oldSessions.length;
      }
      /**
       * Delete event rows whose session_id has no matching session_meta row.
       *
       * Orphaned events accumulate when meta rows were aged out by an older
       * version of `cleanupOldSessions` but the matching events were left
       * behind (or when callers wrote events without a meta upsert). The Kimi
       * Code sessionstart hook calls this on every startup as a self-healing
       * step; surfacing it as a SessionDB method keeps the SQL definition in
       * one place instead of letting hook scripts reach through to
       * `db.db.exec(...)` and re-encode schema knowledge in mjs files.
       */
      pruneOrphanedEvents() {
        const result = this.db.prepare(
          `DELETE FROM session_events WHERE session_id NOT IN (SELECT session_id FROM session_meta)`
        ).run();
        return Number(result.changes ?? 0);
      }
    };
  }
});

// src/adapters/types.ts
var JS_RUNTIMES;
var init_types = __esm({
  "src/adapters/types.ts"() {
    "use strict";
    init_runtime();
    JS_RUNTIMES = /* @__PURE__ */ new Set(["node", "bun", "deno"]);
  }
});

// src/runtime.ts
import { execFileSync as execFileSync2, execSync } from "node:child_process";
import { existsSync as existsSync3 } from "node:fs";
function runtimeBasename(runtimePath) {
  const segments = runtimePath.split(/[\\/]/);
  return segments[segments.length - 1] ?? runtimePath;
}
function isAllowlistedShell(shellPath) {
  return ALLOWED_SHELL_BASENAMES.test(runtimeBasename(shellPath));
}
function isWindowsWslBash(shellPath) {
  const lower = shellPath.toLowerCase().replace(/\//g, "\\");
  return /\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(lower) || /\\microsoft\\windowsapps\\bash\.exe$/.test(lower);
}
function isWindowsSystemCmd(shellPath) {
  const lower = shellPath.toLowerCase().replace(/\//g, "\\");
  return /\\windows\\(?:system32|sysnative)\\cmd\.exe$/.test(lower);
}
function commandExists(cmd) {
  try {
    const check = isWindows ? `where ${cmd}` : `command -v ${cmd}`;
    execSync(check, { stdio: "pipe", env: safeChildProcessEnvironment() });
    return true;
  } catch {
    return false;
  }
}
function runnableExists(cmd) {
  if (isWindows) {
    try {
      const out = execSync(`where ${cmd}`, {
        encoding: "utf-8",
        stdio: "pipe",
        env: safeChildProcessEnvironment()
      });
      const hits = out.trim().split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
      if (hits.length === 0) return false;
      const realHits = hits.filter((p) => !/\\Microsoft\\WindowsApps\\/i.test(p));
      if (realHits.length === 0) return false;
    } catch {
      return false;
    }
  } else if (!commandExists(cmd)) {
    return false;
  }
  try {
    if (isWindows) {
      execSync(`"${cmd}" --version`, {
        stdio: "pipe",
        timeout: 5e3,
        env: safeChildProcessEnvironment()
      });
    } else {
      execFileSync2(cmd, ["--version"], {
        stdio: "pipe",
        timeout: 1500,
        env: safeChildProcessEnvironment()
      });
    }
    return true;
  } catch {
    return false;
  }
}
function bunExists() {
  if (commandExists("bun")) return true;
  for (const p of bunFallbackPaths()) {
    if (existsSync3(p)) return true;
  }
  return false;
}
function bunCommand() {
  for (const p of bunFallbackPaths()) {
    if (existsSync3(p)) return p;
  }
  if (commandExists("bun")) return "bun";
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return isWindows ? `${home}\\.bun\\bin\\bun.exe` : `${home}/.bun/bin/bun`;
}
function bunFallbackPaths() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (isWindows) {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const appData = process.env.APPDATA ?? "";
    return [
      // Native bun installer locations (irm bun.sh/install.ps1).
      ...home ? [`${home}\\.bun\\bin\\bun.exe`] : [],
      ...localAppData ? [`${localAppData}\\bun\\bin\\bun.exe`] : [],
      // npm i -g bun installs bun.exe under the npm prefix (typically
      // %APPDATA%\npm\node_modules\bun\bin\bun.exe). Without this, npm
      // installs were "found" via bun.cmd shim on PATH and the bare "bun"
      // string was returned — spawn() then ENOENT'd because CreateProcess
      // can't execute .cmd files (#506).
      ...appData ? [`${appData}\\npm\\node_modules\\bun\\bin\\bun.exe`] : []
    ];
  }
  return home ? [`${home}/.bun/bin/bun`] : [];
}
function resolveWindowsBash() {
  let candidates;
  try {
    const result = execSync("where bash", {
      encoding: "utf-8",
      stdio: "pipe",
      env: safeChildProcessEnvironment()
    });
    candidates = result.trim().split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
  } catch {
    return null;
  }
  for (const p of candidates) {
    const lower = p.toLowerCase();
    if (lower.includes("system32") || lower.includes("windowsapps")) continue;
    for (const known of KNOWN_GIT_BASH_PATHS) {
      if (existsSync3(known)) return known;
    }
    return p;
  }
  return null;
}
function resolveWindowsShell(windowsBash = resolveWindowsBash()) {
  return windowsBash ?? (commandExists("sh") ? "sh" : commandExists("pwsh") ? "pwsh" : commandExists("powershell") ? "powershell" : "cmd.exe");
}
function resolveJavascriptRuntime(bun, deps = {}) {
  if (bun) return bun;
  const execPath = deps.execPath ?? process.execPath;
  const cmdExists = deps.commandExists ?? commandExists;
  const base = execPath.split(/[\\/]/).pop().replace(/\.exe$/i, "");
  if (JS_RUNTIMES.has(base)) {
    if (existsSync3(execPath)) {
      return execPath;
    }
  }
  if (cmdExists("node")) return "node";
  return null;
}
function detectRuntimes() {
  const hasBun = bunExists();
  const bun = hasBun ? bunCommand() : null;
  const userShell = process.env.SHELL;
  const isWin = process.platform === "win32";
  const windowsBash = isWin ? resolveWindowsBash() : null;
  const shellOverride = userShell && existsSync3(userShell) && isAllowlistedShell(userShell) && !(isWin && isWindowsWslBash(userShell)) && // Windows OpenSSH can inject the system cmd.exe as ambient SHELL. When
  // Git Bash is installed, treating that as an explicit override breaks the
  // POSIX shell executor path restored by #36/#384/#791.
  !(isWin && windowsBash && isWindowsSystemCmd(userShell)) ? userShell : null;
  return {
    javascript: resolveJavascriptRuntime(bun),
    typescript: bun ? bun : commandExists("tsx") ? "tsx" : commandExists("ts-node") ? "ts-node" : null,
    python: runnableExists("python3") ? "python3" : runnableExists("python") ? "python" : runnableExists("py") ? "py" : null,
    shell: shellOverride ?? (isWin ? resolveWindowsShell(windowsBash) : commandExists("bash") ? "bash" : "sh"),
    ruby: commandExists("ruby") ? "ruby" : null,
    go: commandExists("go") ? "go" : null,
    rust: commandExists("rustc") ? "rustc" : null,
    php: commandExists("php") ? "php" : null,
    perl: commandExists("perl") ? "perl" : null,
    r: commandExists("Rscript") ? "Rscript" : commandExists("r") ? "r" : null,
    elixir: commandExists("elixir") ? "elixir" : null,
    csharp: commandExists("dotnet-script") ? "dotnet-script" : null
  };
}
var ALLOWED_SHELL_BASENAMES, isWindows, KNOWN_GIT_BASH_PATHS;
var init_runtime = __esm({
  "src/runtime.ts"() {
    "use strict";
    init_types();
    init_credential_env();
    ALLOWED_SHELL_BASENAMES = /^(bash|sh|zsh|dash|pwsh|powershell|cmd)(\.exe)?$/i;
    isWindows = process.platform === "win32";
    KNOWN_GIT_BASH_PATHS = [
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe"
    ];
  }
});

// src/adapters/client-map.ts
var init_client_map = __esm({
  "src/adapters/client-map.ts"() {
    "use strict";
  }
});

// src/adapters/detect.ts
function foreignWorkspaceEnv(platform) {
  const ban = /* @__PURE__ */ new Set();
  for (const [p, vars] of PLATFORM_ENV_VARS) {
    if (p === platform) continue;
    for (const v of vars) {
      if (v.role === "workspace") ban.add(v.name);
    }
  }
  return ban;
}
function foreignIdentificationEnv(platform) {
  const ban = /* @__PURE__ */ new Set();
  for (const [p, vars] of PLATFORM_ENV_VARS) {
    if (p === platform) continue;
    for (const v of vars) {
      if (v.role === "identification") ban.add(v.name);
    }
  }
  return ban;
}
var _PLATFORM_ENV_VARS_RAW, PLATFORM_ENV_VARS;
var init_detect = __esm({
  "src/adapters/detect.ts"() {
    "use strict";
    init_client_map();
    _PLATFORM_ENV_VARS_RAW = [
      // Order matters: forks listed BEFORE the fork's parent so collision
      // detection works. Every entry verified against platform's own runtime
      // source code (PR #376 follow-up: full audit, May 2026 — see git blame).
      // Claude Code — verified against a live `env` dump (2026-05-11):
      //   CLAUDE_CODE_ENTRYPOINT=cli              (set on every CC session)
      //   CLAUDE_PLUGIN_ROOT=/Users/.../<version>  (set when a plugin is loaded)
      //   CLAUDE_PROJECT_DIR=/Users/.../project    (set in hooks context)
      //   CLAUDE_SESSION_ID=<uuid>                 (legacy session marker)
      // CLAUDE_CODE_ENTRYPOINT and CLAUDE_PLUGIN_ROOT are CC-exclusive — they
      // are the disambiguators for issue #539 (Claude Code running inside a
      // VS Code integrated terminal that has VSCODE_PID set). They MUST be
      // checked here so detect resolves to claude-code BEFORE falling through
      // to vscode-copilot below.
      ["claude-code", [
        { name: "CLAUDE_CODE_ENTRYPOINT", role: "identification" },
        { name: "CLAUDE_PLUGIN_ROOT", role: "identification" },
        { name: "CLAUDE_PROJECT_DIR", role: "workspace" },
        { name: "CLAUDE_SESSION_ID", role: "identification" }
      ]],
      // antigravity (Electron/VSCode fork) — google-gemini/gemini-cli
      // packages/core/src/ide/detect-ide.ts checks ANTIGRAVITY_CLI_ALIAS as the
      // canonical Antigravity marker. Listed before vscode-copilot.
      ["antigravity", [
        { name: "ANTIGRAVITY_CLI_ALIAS", role: "identification" }
      ]],
      // cursor (VSCode fork) — listed before vscode-copilot. CURSOR_TRACE_ID has
      // 800+ hits in major OSS detection libs (Vercel Next.js, Bun, Google
      // gemini-cli, Nx, CrewAI). CURSOR_CWD is the documented workspace var
      // (issue #521) — listed first so workspace cascade picks it up.
      ["cursor", [
        { name: "CURSOR_CWD", role: "workspace" },
        { name: "CURSOR_TRACE_ID", role: "identification" },
        { name: "CURSOR_CLI", role: "identification" }
      ]],
      // kilo (OpenCode fork) — Kilo-Org/kilocode packages/opencode/src/index.ts:138 + 139
      // sets `process.env.KILO = 1` + `process.env.KILO_PID = String(process.pid)`.
      ["kilo", [
        { name: "KILO", role: "identification" },
        { name: "KILO_PID", role: "identification" }
      ]],
      // opencode — sst/opencode packages/opencode/src/index.ts:108-109 sets
      // OPENCODE=1 + OPENCODE_PID=<pid> on CLI invocations. OpenCode desktop
      // shells also expose OPENCODE_CLIENT=desktop and OPENCODE_TERMINAL=1.
      // OPENCODE_PROJECT_DIR is the documented workspace var (consumed by the
      // legacy resolver cascade) — listed first so the workspace cascade picks
      // it up under strict mode.
      ["opencode", [
        { name: "OPENCODE_PROJECT_DIR", role: "workspace" },
        { name: "OPENCODE_CLIENT", role: "identification" },
        { name: "OPENCODE_TERMINAL", role: "identification" },
        { name: "OPENCODE", role: "identification" },
        { name: "OPENCODE_PID", role: "identification" }
      ]],
      // zed — zed-industries/zed crates/terminal/src/terminal.rs sets ZED_TERM=true
      // in `insert_zed_terminal_env()`. Google's gemini-cli uses ZED_SESSION_ID.
      ["zed", [
        { name: "ZED_SESSION_ID", role: "identification" },
        { name: "ZED_TERM", role: "identification" }
      ]],
      // codex — openai/codex codex-rs/core/src/exec_env.rs sets CODEX_THREAD_ID
      // per exec; unified_exec/process_manager.rs sets CODEX_CI in CI mode.
      ["codex", [
        { name: "CODEX_THREAD_ID", role: "identification" },
        { name: "CODEX_CI", role: "identification" }
      ]],
      // gemini-cli — GEMINI_PROJECT_DIR per google-gemini/gemini-cli
      // docs/hooks/index.md; GEMINI_CLI is the MCP-server sentinel.
      ["gemini-cli", [
        { name: "GEMINI_PROJECT_DIR", role: "workspace" },
        { name: "GEMINI_CLI", role: "identification" }
      ]],
      // vscode-copilot — VSCODE_PID + VSCODE_CWD set by microsoft/vscode bootstrap.
      // Listed AFTER cursor and antigravity since they inherit these vars as forks.
      ["vscode-copilot", [
        { name: "VSCODE_CWD", role: "workspace" },
        { name: "VSCODE_PID", role: "identification" }
      ]],
      // jetbrains-copilot — IDEA_INITIAL_DIRECTORY set by JetBrains launcher.
      // (IDEA_HOME and JETBRAINS_CLIENT_ID removed — no source-line evidence.)
      ["jetbrains-copilot", [
        { name: "IDEA_INITIAL_DIRECTORY", role: "workspace" }
      ]],
      // qwen-code — QWEN_PROJECT_DIR per QwenLM/qwen-code docs/users/features/hooks.md.
      // (QWEN_SESSION_ID removed — 0 hits in qwen-code repository.)
      ["qwen-code", [
        { name: "QWEN_PROJECT_DIR", role: "workspace" }
      ]],
      // omp (can1357/oh-my-pi). PI_CODING_AGENT_DIR is the upstream
      // agent-dir override per `packages/utils/src/dirs.ts:193`. Listed
      // BEFORE pi so OMP is not misclassified as Pi when both are installed.
      ["omp", [
        { name: "PI_CODING_AGENT_DIR", role: "workspace" }
      ]],
      // pi — Issue #542 marker correction. PI_PROJECT_DIR is a consumer-set
      // var (read by src/adapters/pi/extension.ts) but is NOT auto-set by
      // the Pi runtime — verified against
      //   refs/platforms/oh-my-pi/packages/coding-agent/src/mcp/transports/stdio.ts:55-63
      // (env passthrough only, no synthesis). The Pi runtime DOES set
      // PI_CONFIG_DIR (config dir override), PI_SESSION_FILE (active session
      // path), PI_COMPILED (binary build marker), and PI_CODING_AGENT=true
      // in package-spawned MCP children (#760). PI_CODING_AGENT_DIR is owned
      // by OMP above; keep it there.
      //
      // Issue #545 — PI_WORKSPACE_DIR / PI_PROJECT_DIR are workspace vars set
      // by Pi's bridge so the resolver picks them up under strict mode.
      // PI_WORKSPACE_DIR comes first (extension-set, freshest) before
      // PI_PROJECT_DIR (user override) per registry-author cascade order.
      ["pi", [
        // Issue #545 — workspace vars set by Pi's bridge so resolveProjectDir
        // under strict mode picks them up. detect=false because PI_*_DIR are
        // consumer-set and must NOT misclassify a non-Pi host as Pi (#542).
        { name: "PI_WORKSPACE_DIR", role: "workspace", detect: false },
        { name: "PI_PROJECT_DIR", role: "workspace", detect: false },
        { name: "PI_CONFIG_DIR", role: "identification" },
        { name: "PI_SESSION_FILE", role: "identification" },
        { name: "PI_COMPILED", role: "identification" },
        { name: "PI_CODING_AGENT", role: "identification" }
      ]]
      // openclaw — removed (runtime never sets OPENCLAW_HOME or OPENCLAW_CLI;
      // detection falls through to ~/.openclaw/ config-dir tier below).
      // kiro — not listed (no auto-set process env vars; ~/.kiro/ config-dir tier).
    ];
    PLATFORM_ENV_VARS = new Map(
      _PLATFORM_ENV_VARS_RAW
    );
  }
});

// src/adapters/base.ts
import { join as join4, resolve as resolve2 } from "node:path";
import { accessSync as accessSync2, copyFileSync, constants as constants2, mkdirSync as mkdirSync2 } from "node:fs";
import { homedir } from "node:os";
function resolveContextModeDataRoot(env = process.env) {
  const raw = env.CONTEXT_MODE_DATA_DIR;
  if (!raw || raw.trim() === "") return null;
  if (raw.startsWith("~")) {
    return resolve2(homedir(), raw.replace(/^~[/\\]?/, ""));
  }
  return resolve2(raw);
}
var BaseAdapter;
var init_base = __esm({
  "src/adapters/base.ts"() {
    "use strict";
    init_db();
    BaseAdapter = class {
      constructor(sessionDirSegments) {
        this.sessionDirSegments = sessionDirSegments;
      }
      sessionDirSegments;
      getSessionDir() {
        const override = resolveContextModeDataRoot();
        const dir = override ? join4(override, "context-mode", "sessions") : join4(homedir(), ...this.sessionDirSegments, "context-mode", "sessions");
        mkdirSync2(dir, { recursive: true });
        return dir;
      }
      /**
       * Default: build config dir from sessionDirSegments rooted at $HOME.
       *
       * Contract: ALWAYS returns an absolute path. Adapters with project-scoped
       * or non-home-rooted config dirs (cursor, vscode-copilot, jetbrains-copilot,
       * openclaw, opencode) override this and resolve their segments against
       * `projectDir` (or `process.cwd()` when omitted).
       *
       * NOT relocated by `CONTEXT_MODE_DATA_DIR` (#649). The platform owns its
       * settings.json / hooks.json / config.toml location — relocating that
       * would silently fork platform behaviour from the platform's own tooling.
       * Use `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`, etc. to move
       * platform-native config; use `CONTEXT_MODE_DATA_DIR` to move context-mode
       * storage independently.
       *
       * @param _projectDir Unused by the home-rooted default — accepted so
       *                    project-scoped overrides honor the same signature.
       */
      getConfigDir(_projectDir) {
        return join4(homedir(), ...this.sessionDirSegments);
      }
      /**
       * Default: Claude Code convention. Most adapters override with their
       * own platform-specific instruction file name (AGENTS.md, GEMINI.md, ...).
       */
      getInstructionFiles() {
        return ["CLAUDE.md"];
      }
      /**
       * Default: <configDir>/memory/<projectHash>. Always absolute (configDir is
       * absolute by contract). Adapters with a different memory dir name (e.g.,
       * codex uses "memories" plural) override this.
       *
       * Issue #649: when `CONTEXT_MODE_DATA_DIR` is set, memory follows storage
       * to `<DATA_DIR>/context-mode/memory/` since persistent memory is
       * context-mode-owned state, not platform-native config.
       *
       * Issue #663: when `projectDir` is supplied the path is scoped via
       * `hashProjectDirCanonical(projectDir)` so two projects running in
       * parallel never share auto-memory contents. When omitted (legacy
       * callers), the unscoped path is returned for backwards compatibility.
       */
      getMemoryDir(projectDir) {
        const override = resolveContextModeDataRoot();
        const base = override ? join4(override, "context-mode", "memory") : join4(this.getConfigDir(), "memory");
        if (!projectDir) return base;
        return join4(base, hashProjectDirCanonical(projectDir));
      }
      backupSettings() {
        const settingsPath = this.getSettingsPath();
        try {
          accessSync2(settingsPath, constants2.R_OK);
          const backupPath = settingsPath + ".bak";
          copyFileSync(settingsPath, backupPath);
          return backupPath;
        } catch {
          return null;
        }
      }
    };
  }
});

// src/adapters/pi/index.ts
import {
  readFileSync,
  writeFileSync,
  mkdirSync as mkdirSync3
} from "node:fs";
import { resolve as resolve3, dirname as dirname2 } from "node:path";
import { homedir as homedir2 } from "node:os";
var PiAdapter;
var init_index = __esm({
  "src/adapters/pi/index.ts"() {
    "use strict";
    init_base();
    PiAdapter = class extends BaseAdapter {
      constructor() {
        super([".pi"]);
      }
      name = "Pi";
      paradigm = "mcp-only";
      capabilities = {
        preToolUse: false,
        postToolUse: false,
        preCompact: false,
        sessionStart: false,
        canModifyArgs: false,
        canModifyOutput: false,
        canInjectSessionContext: false
      };
      // ── Input parsing ──────────────────────────────────────
      // Pi does not feed the adapter via JSON-stdio. These methods exist to
      // satisfy the HookAdapter contract and throw if the harness mistakenly
      // routes a JSON-stdio event through the adapter.
      parsePreToolUseInput(_raw) {
        throw new Error("Pi does not support JSON-stdio hooks (wired via extension.ts)");
      }
      parsePostToolUseInput(_raw) {
        throw new Error("Pi does not support JSON-stdio hooks (wired via extension.ts)");
      }
      parsePreCompactInput(_raw) {
        throw new Error("Pi does not support JSON-stdio hooks (wired via extension.ts)");
      }
      parseSessionStartInput(_raw) {
        throw new Error("Pi does not support JSON-stdio hooks (wired via extension.ts)");
      }
      // ── Response formatting ────────────────────────────────
      // No JSON-stdio path — return undefined to satisfy the contract.
      formatPreToolUseResponse(_response) {
        return void 0;
      }
      formatPostToolUseResponse(_response) {
        return void 0;
      }
      formatPreCompactResponse(_response) {
        return void 0;
      }
      formatSessionStartResponse(_response) {
        return void 0;
      }
      // ── Configuration ──────────────────────────────────────
      getSettingsPath() {
        return resolve3(homedir2(), ".pi", "settings.json");
      }
      getInstructionFiles() {
        return ["AGENTS.md"];
      }
      generateHookConfig(_pluginRoot) {
        return {};
      }
      readSettings() {
        try {
          const raw = readFileSync(this.getSettingsPath(), "utf-8");
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }
      writeSettings(settings) {
        const settingsPath = this.getSettingsPath();
        mkdirSync3(dirname2(settingsPath), { recursive: true });
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
      }
      // ── Diagnostics (doctor) ─────────────────────────────────
      validateHooks(_pluginRoot) {
        return [
          {
            check: "Hook support",
            status: "pass",
            message: "Pi hooks are wired via the context-mode Pi extension (~/.pi/extensions/context-mode/), not via JSON-stdio."
          }
        ];
      }
      checkPluginRegistration() {
        const pkgPath = resolve3(
          homedir2(),
          ".pi",
          "extensions",
          "context-mode",
          "package.json"
        );
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
          if (pkg?.name === "context-mode") {
            return {
              check: "Pi extension registration",
              status: "pass",
              message: `context-mode extension installed at ${pkgPath}`
            };
          }
          return {
            check: "Pi extension registration",
            status: "warn",
            message: `Unexpected package at ${pkgPath}`
          };
        } catch {
          return {
            check: "Pi extension registration",
            status: "fail",
            message: `context-mode not found at ${pkgPath}`,
            fix: "Run: context-mode upgrade"
          };
        }
      }
      getInstalledVersion() {
        try {
          const pkgPath = resolve3(
            homedir2(),
            ".pi",
            "extensions",
            "context-mode",
            "package.json"
          );
          const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
          return pkg.version ?? "unknown";
        } catch {
          return "not installed";
        }
      }
      // ── Upgrade ────────────────────────────────────────────
      // Pi does NOT use settings.json hook entries. The extension is the
      // integration point — there is nothing for the harness to register
      // beyond copying the extension into ~/.pi/extensions/context-mode/.
      configureAllHooks(_pluginRoot) {
        return [];
      }
      setHookPermissions(_pluginRoot) {
        return [];
      }
      updatePluginRegistry(_pluginRoot, _version) {
      }
      getRoutingInstructions() {
        return "# context-mode\n\nUse context-mode MCP tools (ctx_execute, ctx_execute_file, ctx_batch_execute, ctx_fetch_and_index, ctx_search) instead of inline shell/HTTP calls for data-heavy operations.";
      }
    };
  }
});

// src/adapters/pi/extension.ts
init_db();
import { createHash as createHash2 } from "node:crypto";
import { existsSync as existsSync5, mkdirSync as mkdirSync4 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join5, resolve as resolve4, dirname as dirname3 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// src/session/model-prices.json
var model_prices_default = {
  "claude-opus-4-8": {
    input_per_mtok: 5,
    output_per_mtok: 25,
    cache_read_per_mtok: 0.5,
    cache_write_per_mtok: 6.25,
    source: "https://platform.claude.com/docs/en/about-claude/pricing"
  },
  "claude-opus-4-7": {
    input_per_mtok: 5,
    output_per_mtok: 25,
    cache_read_per_mtok: 0.5,
    cache_write_per_mtok: 6.25,
    source: "https://platform.claude.com/docs/en/about-claude/pricing"
  },
  "claude-opus-4-6": {
    input_per_mtok: 5,
    output_per_mtok: 25,
    cache_read_per_mtok: 0.5,
    cache_write_per_mtok: 6.25,
    source: "https://platform.claude.com/docs/en/about-claude/pricing"
  },
  "claude-opus-4-5": {
    input_per_mtok: 5,
    output_per_mtok: 25,
    cache_read_per_mtok: 0.5,
    cache_write_per_mtok: 6.25,
    source: "https://platform.claude.com/docs/en/about-claude/pricing"
  },
  "claude-sonnet-4-6": {
    input_per_mtok: 3,
    output_per_mtok: 15,
    cache_read_per_mtok: 0.3,
    cache_write_per_mtok: 3.75,
    source: "https://platform.claude.com/docs/en/about-claude/pricing"
  },
  "claude-sonnet-4-5": {
    input_per_mtok: 3,
    output_per_mtok: 15,
    cache_read_per_mtok: 0.3,
    cache_write_per_mtok: 3.75,
    source: "https://platform.claude.com/docs/en/about-claude/pricing"
  },
  "claude-haiku-4-5": {
    input_per_mtok: 1,
    output_per_mtok: 5,
    cache_read_per_mtok: 0.1,
    cache_write_per_mtok: 1.25,
    source: "https://platform.claude.com/docs/en/about-claude/pricing"
  },
  "claude-3-7-sonnet": {
    input_per_mtok: 3,
    output_per_mtok: 15,
    cache_read_per_mtok: 0.3,
    cache_write_per_mtok: 3.75,
    source: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
  },
  "claude-3-5-haiku": {
    input_per_mtok: 0.8,
    output_per_mtok: 4,
    cache_read_per_mtok: 0.08,
    cache_write_per_mtok: 1,
    source: "https://platform.claude.com/docs/en/about-claude/pricing"
  },
  "claude-fable-5": {
    input_per_mtok: 10,
    output_per_mtok: 50,
    cache_read_per_mtok: 1,
    cache_write_per_mtok: 12.5,
    source: "https://platform.claude.com/docs/en/about-claude/pricing"
  },
  "gpt-5": {
    input_per_mtok: 1.25,
    output_per_mtok: 10,
    cache_read_per_mtok: 0.125,
    cache_write_per_mtok: null,
    source: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
  },
  "gpt-5-mini": {
    input_per_mtok: 0.25,
    output_per_mtok: 2,
    cache_read_per_mtok: 0.025,
    cache_write_per_mtok: null,
    source: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
  },
  "gpt-5-nano": {
    input_per_mtok: 0.05,
    output_per_mtok: 0.4,
    cache_read_per_mtok: 5e-3,
    cache_write_per_mtok: null,
    source: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
  },
  "gpt-5-codex": {
    input_per_mtok: 1.25,
    output_per_mtok: 10,
    cache_read_per_mtok: 0.125,
    cache_write_per_mtok: null,
    source: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
  },
  "gpt-4.1": {
    input_per_mtok: 2,
    output_per_mtok: 8,
    cache_read_per_mtok: 0.5,
    cache_write_per_mtok: null,
    source: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
  },
  "gpt-4.1-mini": {
    input_per_mtok: 0.4,
    output_per_mtok: 1.6,
    cache_read_per_mtok: 0.1,
    cache_write_per_mtok: null,
    source: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
  },
  "gpt-4.1-nano": {
    input_per_mtok: 0.1,
    output_per_mtok: 0.4,
    cache_read_per_mtok: 0.025,
    cache_write_per_mtok: null,
    source: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
  },
  "gpt-4o": {
    input_per_mtok: 2.5,
    output_per_mtok: 10,
    cache_read_per_mtok: 1.25,
    cache_write_per_mtok: null,
    source: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
  },
  "gpt-4o-mini": {
    input_per_mtok: 0.15,
    output_per_mtok: 0.6,
    cache_read_per_mtok: 0.075,
    cache_write_per_mtok: null,
    source: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
  },
  o3: {
    input_per_mtok: 2,
    output_per_mtok: 8,
    cache_read_per_mtok: 0.5,
    cache_write_per_mtok: null,
    source: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
  },
  "o4-mini": {
    input_per_mtok: 1.1,
    output_per_mtok: 4.4,
    cache_read_per_mtok: 0.275,
    cache_write_per_mtok: null,
    source: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
  },
  "o3-mini": {
    input_per_mtok: 1.1,
    output_per_mtok: 4.4,
    cache_read_per_mtok: 0.55,
    cache_write_per_mtok: null,
    source: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
  },
  "codex-mini-latest": {
    input_per_mtok: 1.5,
    output_per_mtok: 6,
    cache_read_per_mtok: 0.375,
    cache_write_per_mtok: null,
    source: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
  },
  "gemini-2.5-pro": {
    input_per_mtok: 1.25,
    output_per_mtok: 10,
    cache_read_per_mtok: 0.125,
    cache_write_per_mtok: null,
    source: "https://ai.google.dev/gemini-api/docs/pricing"
  },
  "gemini-2.5-flash": {
    input_per_mtok: 0.3,
    output_per_mtok: 2.5,
    cache_read_per_mtok: 0.03,
    cache_write_per_mtok: null,
    source: "https://ai.google.dev/gemini-api/docs/pricing"
  },
  "gemini-2.5-flash-lite": {
    input_per_mtok: 0.1,
    output_per_mtok: 0.4,
    cache_read_per_mtok: 0.01,
    cache_write_per_mtok: null,
    source: "https://ai.google.dev/gemini-api/docs/pricing"
  },
  "gemini-2.0-flash": {
    input_per_mtok: 0.1,
    output_per_mtok: 0.4,
    cache_read_per_mtok: 0.025,
    cache_write_per_mtok: null,
    source: "https://ai.google.dev/gemini-api/docs/pricing"
  },
  "gemini-2.0-flash-lite": {
    input_per_mtok: 0.075,
    output_per_mtok: 0.3,
    cache_read_per_mtok: null,
    cache_write_per_mtok: null,
    source: "https://ai.google.dev/gemini-api/docs/pricing"
  },
  "gemini-3-pro-preview": {
    input_per_mtok: 2,
    output_per_mtok: 12,
    cache_read_per_mtok: 0.2,
    cache_write_per_mtok: null,
    source: "https://ai.google.dev/gemini-api/docs/pricing"
  },
  "gemini-3-flash-preview": {
    input_per_mtok: 0.5,
    output_per_mtok: 3,
    cache_read_per_mtok: 0.05,
    cache_write_per_mtok: null,
    source: "https://ai.google.dev/gemini-api/docs/pricing"
  },
  "qwen3-coder": {
    input_per_mtok: 1,
    output_per_mtok: 5,
    cache_read_per_mtok: null,
    cache_write_per_mtok: null,
    source: "https://www.alibabacloud.com/help/en/model-studio/models"
  },
  "qwen-max": {
    input_per_mtok: 1.6,
    output_per_mtok: 6.4,
    cache_read_per_mtok: null,
    cache_write_per_mtok: null,
    source: "https://www.alibabacloud.com/help/en/model-studio/models"
  },
  "qwen-plus": {
    input_per_mtok: 0.4,
    output_per_mtok: 1.2,
    cache_read_per_mtok: null,
    cache_write_per_mtok: null,
    source: "https://www.alibabacloud.com/help/en/model-studio/models"
  },
  "qwen-turbo": {
    input_per_mtok: 0.05,
    output_per_mtok: 0.2,
    cache_read_per_mtok: null,
    cache_write_per_mtok: null,
    source: "https://www.alibabacloud.com/help/en/model-studio/models"
  },
  "qwen3-max": {
    input_per_mtok: 1.2,
    output_per_mtok: 6,
    cache_read_per_mtok: null,
    cache_write_per_mtok: null,
    source: "https://www.alibabacloud.com/help/en/model-studio/models"
  },
  "kimi-k2": {
    input_per_mtok: 0.6,
    output_per_mtok: 2.5,
    cache_read_per_mtok: 0.15,
    cache_write_per_mtok: null,
    source: "https://platform.moonshot.ai/docs/pricing/chat"
  },
  "kimi-k2-turbo": {
    input_per_mtok: 1.15,
    output_per_mtok: 8,
    cache_read_per_mtok: 0.15,
    cache_write_per_mtok: null,
    source: "https://platform.moonshot.ai/docs/pricing/chat"
  },
  "moonshot-v1-8k": {
    input_per_mtok: 0.2,
    output_per_mtok: 2,
    cache_read_per_mtok: null,
    cache_write_per_mtok: null,
    source: "https://platform.moonshot.ai/docs/pricing"
  },
  "moonshot-v1-32k": {
    input_per_mtok: 1,
    output_per_mtok: 3,
    cache_read_per_mtok: null,
    cache_write_per_mtok: null,
    source: "https://platform.moonshot.ai/docs/pricing"
  },
  "moonshot-v1-128k": {
    input_per_mtok: 2,
    output_per_mtok: 5,
    cache_read_per_mtok: null,
    cache_write_per_mtok: null,
    source: "https://platform.moonshot.ai/docs/pricing"
  },
  "deepseek-v3": {
    input_per_mtok: 0.27,
    output_per_mtok: 1.1,
    cache_read_per_mtok: 0.07,
    cache_write_per_mtok: 0,
    source: "https://api-docs.deepseek.com/quick_start/pricing"
  },
  "deepseek-r1": {
    input_per_mtok: 0.55,
    output_per_mtok: 2.19,
    cache_read_per_mtok: null,
    cache_write_per_mtok: null,
    source: "https://api-docs.deepseek.com/quick_start/pricing"
  },
  "deepseek-chat": {
    input_per_mtok: 0.14,
    output_per_mtok: 0.28,
    cache_read_per_mtok: 28e-4,
    cache_write_per_mtok: null,
    source: "https://api-docs.deepseek.com/quick_start/pricing"
  },
  "deepseek-reasoner": {
    input_per_mtok: 0.14,
    output_per_mtok: 0.28,
    cache_read_per_mtok: 28e-4,
    cache_write_per_mtok: null,
    source: "https://api-docs.deepseek.com/quick_start/pricing"
  },
  "glm-4.6": {
    input_per_mtok: 0.6,
    output_per_mtok: 2.2,
    cache_read_per_mtok: 0.11,
    cache_write_per_mtok: null,
    source: "https://docs.z.ai/guides/overview/pricing"
  },
  "glm-4-air": {
    input_per_mtok: 0.2,
    output_per_mtok: 1.1,
    cache_read_per_mtok: 0.03,
    cache_write_per_mtok: null,
    source: "https://docs.z.ai/guides/overview/pricing"
  },
  "grok-4": {
    input_per_mtok: 3,
    output_per_mtok: 15,
    cache_read_per_mtok: null,
    cache_write_per_mtok: null,
    source: "https://docs.x.ai/docs/pricing"
  },
  "grok-3": {
    input_per_mtok: 3,
    output_per_mtok: 15,
    cache_read_per_mtok: 0.75,
    cache_write_per_mtok: null,
    source: "https://docs.x.ai/docs/pricing"
  },
  "grok-code-fast-1": {
    input_per_mtok: 0.2,
    output_per_mtok: 1.5,
    cache_read_per_mtok: 0.02,
    cache_write_per_mtok: null,
    source: "https://docs.x.ai/docs/pricing"
  },
  "grok-2": {
    input_per_mtok: 2,
    output_per_mtok: 10,
    cache_read_per_mtok: null,
    cache_write_per_mtok: null,
    source: "https://docs.x.ai/docs/pricing"
  },
  "mistral-large-latest": {
    input_per_mtok: 0.5,
    output_per_mtok: 1.5,
    cache_read_per_mtok: null,
    cache_write_per_mtok: null,
    source: "https://mistral.ai/pricing"
  },
  "codestral-latest": {
    input_per_mtok: 0.3,
    output_per_mtok: 0.9,
    cache_read_per_mtok: null,
    cache_write_per_mtok: null,
    source: "https://mistral.ai/pricing"
  },
  devstral: {
    input_per_mtok: 0.4,
    output_per_mtok: 2,
    cache_read_per_mtok: null,
    cache_write_per_mtok: null,
    source: "https://mistral.ai/pricing"
  },
  "mistral-medium": {
    input_per_mtok: 0.4,
    output_per_mtok: 2,
    cache_read_per_mtok: null,
    cache_write_per_mtok: null,
    source: "https://mistral.ai/pricing"
  },
  "llama-4-maverick": {
    input_per_mtok: 0.27,
    output_per_mtok: 0.85,
    cache_read_per_mtok: null,
    cache_write_per_mtok: null,
    source: "https://www.together.ai/pricing"
  },
  "llama-4-scout": {
    input_per_mtok: 0.08,
    output_per_mtok: 0.3,
    cache_read_per_mtok: null,
    cache_write_per_mtok: null,
    source: "https://www.together.ai/pricing"
  },
  "llama-3.3-70b": {
    input_per_mtok: 0.88,
    output_per_mtok: 0.88,
    cache_read_per_mtok: null,
    cache_write_per_mtok: null,
    source: "https://www.together.ai/pricing"
  },
  "command-a": {
    input_per_mtok: 2.5,
    output_per_mtok: 10,
    cache_read_per_mtok: null,
    cache_write_per_mtok: null,
    source: "https://cohere.com/pricing"
  },
  "command-r-plus": {
    input_per_mtok: 2.5,
    output_per_mtok: 10,
    cache_read_per_mtok: null,
    cache_write_per_mtok: null,
    source: "https://cohere.com/pricing"
  },
  "amazon-nova-pro": {
    input_per_mtok: 0.8,
    output_per_mtok: 3.2,
    cache_read_per_mtok: null,
    cache_write_per_mtok: null,
    source: "https://aws.amazon.com/bedrock/pricing/"
  },
  "amazon-nova-lite": {
    input_per_mtok: 0.06,
    output_per_mtok: 0.24,
    cache_read_per_mtok: null,
    cache_write_per_mtok: null,
    source: "https://aws.amazon.com/bedrock/pricing/"
  }
};

// src/session/pricing.ts
function buildCatalog() {
  const map = /* @__PURE__ */ new Map();
  const src = model_prices_default;
  for (const id of Object.keys(src)) {
    const row = src[id];
    if (row == null || typeof row !== "object") continue;
    if (typeof row.input_per_mtok !== "number") continue;
    map.set(id, {
      input_per_mtok: row.input_per_mtok,
      output_per_mtok: typeof row.output_per_mtok === "number" ? row.output_per_mtok : null,
      cache_read_per_mtok: typeof row.cache_read_per_mtok === "number" ? row.cache_read_per_mtok : null,
      cache_write_per_mtok: typeof row.cache_write_per_mtok === "number" ? row.cache_write_per_mtok : null
    });
  }
  return map;
}
var CATALOG = buildCatalog();
function stripProviderPrefix(id) {
  for (let i = 0; i < id.length; i++) {
    if (id.charCodeAt(i) === 47) {
      if (i === 0 || i === id.length - 1) return null;
      return id.slice(i + 1);
    }
  }
  return null;
}
function normalize(id) {
  return id.trim().toLowerCase();
}
function lookupPrice(modelId) {
  if (typeof modelId !== "string" || modelId.length === 0) return null;
  const exact = CATALOG.get(modelId);
  if (exact) return exact;
  const norm = normalize(modelId);
  const byNorm = CATALOG.get(norm);
  if (byNorm) return byNorm;
  const bare = stripProviderPrefix(norm);
  if (bare) {
    const byBare = CATALOG.get(bare);
    if (byBare) return byBare;
  }
  return null;
}
function bucketCost(tokens, rate, inputRate) {
  if (tokens <= 0) return 0;
  const effective = typeof rate === "number" ? rate : inputRate;
  return tokens * effective;
}
function computeCostUsd(modelId, t) {
  const input = typeof t.input_tokens === "number" ? t.input_tokens : 0;
  const output = typeof t.output_tokens === "number" ? t.output_tokens : 0;
  const cacheRead = typeof t.cache_read_tokens === "number" ? t.cache_read_tokens : 0;
  const cacheCreate = typeof t.cache_creation_tokens === "number" ? t.cache_creation_tokens : 0;
  if (input <= 0 && output <= 0 && cacheRead <= 0 && cacheCreate <= 0) return null;
  const price = lookupPrice(modelId);
  if (!price || typeof price.input_per_mtok !== "number") {
    console.warn(`[pricing] no curated price for model id: ${modelId}`);
    return null;
  }
  const inputRate = price.input_per_mtok;
  const microDollars = bucketCost(input, inputRate, inputRate) + bucketCost(output, price.output_per_mtok, inputRate) + bucketCost(cacheRead, price.cache_read_per_mtok, inputRate) + bucketCost(cacheCreate, price.cache_write_per_mtok, inputRate);
  return microDollars / 1e6;
}

// src/session/extract.ts
function safeString(value) {
  if (value == null) return "";
  return String(value);
}
function safeStringAny(value) {
  if (value == null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}
function isToolError(input) {
  const response = String(input.tool_response ?? "");
  const command = String(input.tool_input?.command ?? "");
  if (response.startsWith("context-mode:") || command.startsWith('echo "context-mode:') || command.startsWith("echo 'context-mode:")) {
    return false;
  }
  const isErrorFlag = input.tool_output?.isError === true || input.tool_output?.is_error === true;
  const isBashError = input.tool_name === "Bash" && /exit code [1-9]|error:|Error:|FAIL|failed/i.test(response);
  return isBashError || isErrorFlag;
}
function extractApplyPatchTargets(command) {
  if (!command) return [];
  const targets = [];
  for (const line of command.split(/\r?\n/)) {
    if (line.startsWith("*** Add File: ")) {
      targets.push({ path: line.slice(14).trim(), type: "file_write" });
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      targets.push({ path: line.slice(17).trim(), type: "file_edit" });
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      targets.push({ path: line.slice(17).trim(), type: "file_edit" });
      continue;
    }
    if (line.startsWith("*** Move to: ")) {
      targets.push({ path: line.slice(13).trim(), type: "file_edit" });
    }
  }
  const seen = /* @__PURE__ */ new Set();
  return targets.filter((target) => {
    if (!target.path) return false;
    const key = `${target.type}:${target.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function isPlanFilePath(filePath) {
  return /(?:^|[/\\])\.claude[/\\]plans[/\\]/.test(filePath);
}
function extractFileAndRule(input) {
  const { tool_name, tool_input, tool_response } = input;
  const events = [];
  if (tool_name === "Read") {
    const filePath = String(tool_input["file_path"] ?? "");
    const isRuleFile = /(?:CLAUDE|AGENTS(?:\.override)?|GEMINI|QWEN|KIRO)\.md$/i.test(filePath) || /\/copilot-instructions\.md$/i.test(filePath) || /\/context-mode\.mdc$/i.test(filePath) || /\.claude[\\/]/i.test(filePath) || /[\\/]memor(?:y|ies)[\\/][^\\/]+\.md$/i.test(filePath);
    if (isRuleFile) {
      events.push({
        type: "rule",
        category: "rule",
        data: safeString(filePath),
        priority: 1
      });
      if (tool_response && tool_response.length > 0) {
        events.push({
          type: "rule_content",
          category: "rule",
          data: safeString(tool_response),
          priority: 1
        });
      }
    }
    events.push({
      type: "file_read",
      category: "file",
      data: safeString(filePath),
      priority: 1
    });
    return events;
  }
  if (tool_name === "Edit") {
    const filePath = String(tool_input["file_path"] ?? "");
    events.push({
      type: "file_edit",
      category: "file",
      data: safeString(filePath),
      priority: 1
    });
    return events;
  }
  if (tool_name === "NotebookEdit") {
    const notebookPath = String(tool_input["notebook_path"] ?? "");
    events.push({
      type: "file_edit",
      category: "file",
      data: safeString(notebookPath),
      priority: 1
    });
    return events;
  }
  if (tool_name === "Write") {
    const filePath = String(tool_input["file_path"] ?? "");
    events.push({
      type: "file_write",
      category: "file",
      data: safeString(filePath),
      priority: 1
    });
    return events;
  }
  if (tool_name === "apply_patch") {
    if (isToolError(input)) return [];
    const patchTargets = extractApplyPatchTargets(
      String(tool_input["command"] ?? tool_input["patch"] ?? "")
    );
    for (const target of patchTargets) {
      events.push({
        type: target.type,
        category: "file",
        data: safeString(target.path),
        priority: 1
      });
    }
    return events;
  }
  if (tool_name === "Glob") {
    const pattern = String(tool_input["pattern"] ?? "");
    events.push({
      type: "file_glob",
      category: "file",
      data: safeString(pattern),
      priority: 3
    });
    return events;
  }
  if (tool_name === "Grep") {
    const searchPattern = String(tool_input["pattern"] ?? "");
    const searchPath = String(tool_input["path"] ?? "");
    events.push({
      type: "file_search",
      category: "file",
      data: safeString(`${searchPattern} in ${searchPath}`),
      priority: 3
    });
    return events;
  }
  return events;
}
function extractCwd(input) {
  if (input.tool_name !== "Bash") return [];
  const cmd = String(input.tool_input["command"] ?? "");
  const cdMatch = cmd.match(/\bcd\s+("([^"]+)"|'([^']+)'|(\S+))/);
  if (!cdMatch) return [];
  const dir = cdMatch[2] ?? cdMatch[3] ?? cdMatch[4] ?? "";
  return [{
    type: "cwd",
    category: "cwd",
    data: safeString(dir),
    priority: 2
  }];
}
function extractError(input) {
  const { tool_response } = input;
  const response = String(tool_response ?? "");
  if (!isToolError(input)) return [];
  return [{
    type: "error_tool",
    category: "error",
    data: safeString(response),
    priority: 2
  }];
}
var GIT_PATTERNS = [
  { pattern: /\bgit\s+checkout\b/, operation: "branch" },
  { pattern: /\bgit\s+commit\b/, operation: "commit" },
  { pattern: /\bgit\s+merge\s+\S+/, operation: "merge" },
  { pattern: /\bgit\s+rebase\b/, operation: "rebase" },
  { pattern: /\bgit\s+stash\b/, operation: "stash" },
  { pattern: /\bgit\s+push\b/, operation: "push" },
  { pattern: /\bgit\s+pull\b/, operation: "pull" },
  { pattern: /\bgit\s+log\b/, operation: "log" },
  { pattern: /\bgit\s+diff\b/, operation: "diff" },
  { pattern: /\bgit\s+status\b/, operation: "status" },
  { pattern: /\bgit\s+branch\b/, operation: "branch" },
  { pattern: /\bgit\s+reset\b/, operation: "reset" },
  { pattern: /\bgit\s+add\b/, operation: "add" },
  { pattern: /\bgit\s+cherry-pick\b/, operation: "cherry-pick" },
  { pattern: /\bgit\s+tag\b/, operation: "tag" },
  { pattern: /\bgit\s+fetch\b/, operation: "fetch" },
  { pattern: /\bgit\s+clone\b/, operation: "clone" },
  { pattern: /\bgit\s+worktree\b/, operation: "worktree" }
];
function extractGit(input) {
  if (input.tool_name !== "Bash") return [];
  const cmd = String(input.tool_input["command"] ?? "");
  const parsed = parseGitInvocation(cmd);
  let match;
  if (parsed && parsed.operation) {
    match = GIT_PATTERNS.find((p) => p.operation === parsed.operation);
  }
  if (!match) {
    match = GIT_PATTERNS.find((p) => p.pattern.test(cmd));
  }
  if (!match) return [];
  const out = [];
  if (parsed?.scopedDir) {
    out.push({
      type: "cwd",
      category: "cwd",
      data: safeString(parsed.scopedDir),
      priority: 2
    });
  }
  if (match.operation === "commit") {
    const msg = extractCommitMessageFromCommand(cmd);
    if (msg) {
      out.push({
        type: "git_commit",
        category: "git",
        data: safeString(msg),
        priority: 2
      });
      return out;
    }
  }
  out.push({
    type: "git",
    category: "git",
    data: safeString(match.operation),
    priority: 2
  });
  return out;
}
function expandHomeTilde(path) {
  if (typeof path !== "string" || path.length === 0) return path;
  if (path === "~") return getHomedirSafe();
  if (path.startsWith("~/")) return getHomedirSafe() + path.slice(1);
  return path;
}
function getHomedirSafe() {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || (process.env.HOMEDRIVE && process.env.HOMEPATH ? process.env.HOMEDRIVE + process.env.HOMEPATH : "");
    return home || "~";
  } catch {
    return "~";
  }
}
function parseGitInvocation(cmd) {
  const tokens = tokenizeCommand(cmd);
  let i = 0;
  while (i < tokens.length && isEnvAssignment(tokens[i])) i++;
  while (i < tokens.length && tokens[i] !== "git" && !tokens[i].endsWith("/git")) {
    if (!isCommonRunner(tokens[i])) break;
    i++;
  }
  if (i >= tokens.length) return null;
  if (tokens[i] !== "git" && !tokens[i].endsWith("/git")) return null;
  i++;
  let scopedDir = null;
  let operation = null;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "-C" || t === "--directory") {
      scopedDir = tokens[i + 1] ?? null;
      i += 2;
      continue;
    }
    if (t.startsWith("--directory=")) {
      scopedDir = t.slice("--directory=".length);
      i++;
      continue;
    }
    if (t.length > 0 && t[0] === "-") {
      i++;
      continue;
    }
    operation = t;
    break;
  }
  if (scopedDir) scopedDir = expandHomeTilde(scopedDir);
  return { scopedDir, operation };
}
function isEnvAssignment(token) {
  if (token.length === 0) return false;
  let sawEq = false;
  for (let j = 0; j < token.length; j++) {
    const c = token.charCodeAt(j);
    if (j === 0) {
      if (!(c >= 65 && c <= 90 || c === 95)) return false;
    } else if (c === 61) {
      sawEq = true;
      break;
    } else if (!(c >= 65 && c <= 90 || c >= 48 && c <= 57 || c === 95)) {
      return false;
    }
  }
  return sawEq;
}
function isCommonRunner(token) {
  switch (token) {
    case "sudo":
    case "doas":
    case "env":
    case "exec":
    case "time":
      return true;
    default:
      return false;
  }
}
function tokenizeCommand(cmd) {
  const tokens = [];
  const n = cmd.length;
  let i = 0;
  while (i < n) {
    while (i < n && (cmd[i] === " " || cmd[i] === "	")) i++;
    if (i >= n) break;
    let buf = "";
    while (i < n && cmd[i] !== " " && cmd[i] !== "	") {
      const ch = cmd[i];
      if (ch === '"' || ch === "'") {
        const quote = ch;
        i++;
        while (i < n && cmd[i] !== quote) {
          if (cmd[i] === "\\" && i + 1 < n) {
            buf += cmd[i + 1];
            i += 2;
          } else {
            buf += cmd[i];
            i++;
          }
        }
        if (i < n) i++;
      } else if (ch === "\\" && i + 1 < n) {
        buf += cmd[i + 1];
        i += 2;
      } else {
        buf += ch;
        i++;
      }
    }
    tokens.push(buf);
  }
  return tokens;
}
function extractCommitMessageFromCommand(cmd) {
  const argv = tokenizeCommand(cmd);
  const longPrefix = "--message=";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.length > longPrefix.length && arg.startsWith(longPrefix)) {
      const v = arg.slice(longPrefix.length);
      return v.length > 0 ? v : null;
    }
    if (arg === "--message") {
      const v = argv[i + 1];
      return v && v.length > 0 ? v : null;
    }
    if (arg.length >= 2 && arg[0] === "-" && arg[1] !== "-" && arg[arg.length - 1] === "m" && isLowerAlphaRun(arg, 1)) {
      const v = argv[i + 1];
      return v && v.length > 0 ? v : null;
    }
  }
  return null;
}
function isLowerAlphaRun(s, start) {
  if (start >= s.length) return false;
  for (let i = start; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 97 || c > 122) return false;
  }
  return true;
}
function extractTask(input) {
  const TASK_TOOLS = /* @__PURE__ */ new Set(["TodoWrite", "TaskCreate", "TaskUpdate"]);
  if (!TASK_TOOLS.has(input.tool_name)) return [];
  const type = input.tool_name === "TaskUpdate" ? "task_update" : input.tool_name === "TaskCreate" ? "task_create" : "task";
  return [{
    type,
    category: "task",
    data: safeString(JSON.stringify(input.tool_input)),
    priority: 1
  }];
}
function fnv1a32Hex(s) {
  let hash = 2166136261;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function extractExitPlanText(input) {
  const inputPlan = input.tool_input["plan"];
  if (typeof inputPlan === "string" && inputPlan.length > 0) return inputPlan;
  const resp = input.tool_response;
  if (typeof resp === "string" && resp.length > 0) {
    try {
      const parsed = JSON.parse(resp);
      if (parsed && typeof parsed === "object" && typeof parsed.plan === "string") {
        return parsed.plan;
      }
    } catch {
    }
  }
  return null;
}
function extractPlan(input) {
  if (input.tool_name === "EnterPlanMode") {
    return [{
      type: "plan_enter",
      category: "plan",
      data: "entered plan mode",
      priority: 2
    }];
  }
  if (input.tool_name === "ExitPlanMode") {
    const events = [];
    const prompts = input.tool_input["allowedPrompts"];
    let detail = Array.isArray(prompts) && prompts.length > 0 ? `exited plan mode (allowed: ${safeStringAny(prompts.map((p) => {
      if (typeof p === "object" && p !== null && "prompt" in p) return String(p.prompt);
      return String(p);
    }).join(", "))})` : "exited plan mode";
    const plan = extractExitPlanText(input);
    if (typeof plan === "string" && plan.length > 0) {
      detail += ` plan_bytes:${plan.length} plan_hash:${fnv1a32Hex(plan)}`;
    }
    events.push({
      type: "plan_exit",
      category: "plan",
      data: safeString(detail),
      priority: 2
    });
    const response = String(input.tool_response ?? "").toLowerCase();
    if (response.includes("approved") || response.includes("approve")) {
      events.push({
        type: "plan_approved",
        category: "plan",
        data: "plan approved by user",
        priority: 1
      });
    } else if (response.includes("rejected") || response.includes("decline") || response.includes("denied")) {
      events.push({
        type: "plan_rejected",
        category: "plan",
        data: safeString(`plan rejected: ${input.tool_response ?? ""}`),
        priority: 2
      });
    }
    return events;
  }
  if (input.tool_name === "Write" || input.tool_name === "Edit") {
    const filePath = String(input.tool_input["file_path"] ?? "");
    if (isPlanFilePath(filePath)) {
      return [{
        type: "plan_file_write",
        category: "plan",
        data: safeString(`plan file: ${filePath.split(/[/\\]/).pop() ?? filePath}`),
        priority: 2
      }];
    }
  }
  if (input.tool_name === "apply_patch") {
    if (isToolError(input)) return [];
    const patchTargets = extractApplyPatchTargets(
      String(input.tool_input["command"] ?? input.tool_input["patch"] ?? "")
    );
    return patchTargets.filter((target) => isPlanFilePath(target.path)).map((target) => ({
      type: "plan_file_write",
      category: "plan",
      data: safeString(`plan file: ${target.path.split(/[/\\]/).pop() ?? target.path}`),
      priority: 2
    }));
  }
  return [];
}
var ENV_PATTERNS = [
  /\bsource\s+\S*activate\b/,
  /\bexport\s+\w+=/,
  /\bnvm\s+use\b/,
  /\bpyenv\s+(shell|local|global)\b/,
  /\bconda\s+activate\b/,
  /\brbenv\s+(shell|local|global)\b/,
  /\bnpm\s+install\b/,
  /\bnpm\s+ci\b/,
  /\bpip\s+install\b/,
  /\bbun\s+install\b/,
  /\byarn\s+(add|install)\b/,
  /\bpnpm\s+(add|install)\b/,
  /\bcargo\s+(install|add)\b/,
  /\bgo\s+(install|get)\b/,
  /\brustup\b/,
  /\basdf\b/,
  /\bvolta\b/,
  /\bdeno\s+install\b/
];
function extractEnv(input) {
  if (input.tool_name !== "Bash") return [];
  const cmd = String(input.tool_input["command"] ?? "");
  const isEnvCmd = ENV_PATTERNS.some((p) => p.test(cmd));
  if (!isEnvCmd) return [];
  const sanitized = cmd.replace(/\bexport\s+(\w+)=\S*/g, "export $1=***");
  return [{
    type: "env",
    category: "env",
    data: safeString(sanitized),
    priority: 2
  }];
}
function extractSkill(input) {
  if (input.tool_name !== "Skill") return [];
  const skillName = String(input.tool_input["skill"] ?? "");
  return [{
    type: "skill",
    category: "skill",
    data: safeString(skillName),
    priority: 2
  }];
}
function extractConstraint(input) {
  if (!input.tool_response?.includes("Error") && !input.tool_output?.isError) return [];
  const response = String(input.tool_response || "");
  const patterns = [/not supported/i, /cannot/i, /does not support/i, /FAIL/i, /refused/i, /permission denied/i, /incompatible/i];
  for (const pattern of patterns) {
    const match = response.match(pattern);
    if (match) {
      const idx = response.toLowerCase().indexOf(match[0].toLowerCase());
      const context = response.slice(Math.max(0, idx - 50), Math.min(response.length, idx + 200)).trim();
      return [{
        type: "constraint_discovered",
        category: "constraint",
        data: safeString(context),
        priority: 2
      }];
    }
  }
  return [];
}
function extractSubagent(input) {
  if (input.tool_name !== "Agent") return [];
  const prompt = safeString(String(input.tool_input["prompt"] ?? input.tool_input["description"] ?? ""));
  const response = input.tool_response ? safeString(String(input.tool_response)) : "";
  const isCompleted = response.length > 0;
  return [{
    type: isCompleted ? "subagent_completed" : "subagent_launched",
    category: "subagent",
    data: isCompleted ? safeString(`[completed] ${prompt} \u2192 ${response}`) : safeString(`[launched] ${prompt}`),
    priority: isCompleted ? 2 : 3
  }];
}
function extractMcp(input) {
  const { tool_name, tool_input, tool_response } = input;
  if (!tool_name.startsWith("mcp__")) return [];
  const parts = tool_name.split("__");
  const toolShort = parts[parts.length - 1] || tool_name;
  const firstArg = Object.values(tool_input).find((v) => typeof v === "string");
  const argStr = firstArg ? `: ${safeString(String(firstArg))}` : "";
  const responseStr = tool_response && tool_response.length > 0 ? `
response: ${safeString(tool_response)}` : "";
  return [{
    type: "mcp",
    category: "mcp",
    data: safeString(`${toolShort}${argStr}${responseStr}`),
    priority: 3
  }];
}
var MCP_PARAMS_BUDGET_BYTES = 2048;
function truncateToBytes(s, maxBytes) {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return { value: s, truncated: false };
  const buf = Buffer.from(s, "utf8");
  let cut = maxBytes;
  while (cut > 0 && (buf[cut] & 192) === 128) cut--;
  return { value: buf.subarray(0, cut).toString("utf8"), truncated: true };
}
var SECRET_KEY_PATTERN = /(authorization|auth_token|access_token|refresh_token|bearer|token|secret|password|passwd|pwd|api[-_]?key|apikey|cookie|set-cookie|signature|private[-_]?key|client[-_]?secret|x[-_]?api[-_]?key)/i;
var REDACTED = "[REDACTED]";
function redactSecrets(value, ancestors = /* @__PURE__ */ new WeakSet()) {
  if (value == null || typeof value !== "object") return value;
  if (ancestors.has(value)) return "[CIRCULAR]";
  ancestors.add(value);
  let out;
  if (Array.isArray(value)) {
    out = value.map((v) => redactSecrets(v, ancestors));
  } else {
    const obj = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(k)) {
        obj[k] = REDACTED;
      } else {
        obj[k] = redactSecrets(v, ancestors);
      }
    }
    out = obj;
  }
  ancestors.delete(value);
  return out;
}
function extractMcpToolCall(input) {
  const { tool_name, tool_input } = input;
  if (!tool_name.startsWith("mcp__")) return [];
  const redactedInput = redactSecrets(tool_input ?? {});
  let paramsStr;
  try {
    paramsStr = JSON.stringify(redactedInput);
  } catch {
    paramsStr = "{}";
  }
  const { value: cappedStr, truncated } = truncateToBytes(paramsStr, MCP_PARAMS_BUDGET_BYTES);
  const payload = truncated ? `{"tool_name":${JSON.stringify(tool_name)},"params_raw":${JSON.stringify(cappedStr)},"truncated":true}` : `{"tool_name":${JSON.stringify(tool_name)},"params":${cappedStr}}`;
  const event = {
    type: "mcp_tool_call",
    category: "mcp_tool_call",
    data: safeString(payload),
    priority: 4
  };
  if (isRetrievalToolName(tool_name)) {
    const response = safeString(input.tool_response);
    if (response.length > 0) {
      event.bytes_retrieved = Buffer.byteLength(response, "utf8");
    }
  }
  return [event];
}
var RETRIEVAL_TOOL_SUFFIXES = ["ctx_search", "ctx_fetch_and_index"];
function isRetrievalToolName(toolName) {
  for (const suffix of RETRIEVAL_TOOL_SUFFIXES) {
    if (toolName.endsWith(suffix)) return true;
  }
  return false;
}
function extractDecision(input) {
  if (input.tool_name !== "AskUserQuestion") return [];
  const questions = input.tool_input["questions"];
  const questionText = Array.isArray(questions) && questions.length > 0 ? String(questions[0]["question"] ?? "") : "";
  const rawResponse = String(input.tool_response ?? "");
  let answerText = "";
  try {
    const parsed = JSON.parse(rawResponse);
    const answers = parsed?.answers;
    if (answers && typeof answers === "object") {
      const toAnswerText = (value) => {
        if (typeof value === "string") return value;
        if (Array.isArray(value)) {
          return value.filter((v) => typeof v === "string").join(" | ");
        }
        return "";
      };
      const matched = questionText ? toAnswerText(answers[questionText]) : "";
      if (matched) {
        answerText = matched;
      } else {
        const values = Object.values(answers).map(toAnswerText).filter((v) => v.length > 0);
        answerText = values.join(" | ");
      }
    }
  } catch {
  }
  const answer = safeString(answerText);
  const summary = questionText ? `Q: ${safeString(questionText)} \u2192 A: ${answer}` : `answer: ${answer}`;
  return [{
    type: "decision_question",
    category: "decision",
    data: safeString(summary),
    priority: 2
  }];
}
function extractAgentFinding(input) {
  if (input.tool_name !== "Agent") return [];
  if (!input.tool_response || input.tool_response.length === 0) return [];
  const summary = input.tool_response.length > 500 ? input.tool_response.slice(0, 500) : input.tool_response;
  return [{
    type: "agent_finding",
    category: "agent-finding",
    data: safeString(summary),
    priority: 2
  }];
}
function extractExternalRef(input) {
  const haystack = [
    safeStringAny(input.tool_input),
    safeString(input.tool_response)
  ].join(" ");
  if (haystack.length === 0) return [];
  const refs = /* @__PURE__ */ new Set();
  const urlMatches = haystack.match(/https?:\/\/[^\s)]+/g);
  if (urlMatches) {
    for (let url of urlMatches) {
      url = url.replace(/["'})\],;.]+$/, "");
      if (!/localhost|127\.0\.0\.1/i.test(url)) {
        refs.add(url);
      }
    }
  }
  const issueMatches = haystack.match(/(?<!\w)#(\d+)/g);
  if (issueMatches) {
    for (const m of issueMatches) {
      refs.add(m);
    }
  }
  if (refs.size === 0) return [];
  let bytesAvoided;
  const preambleMatch = safeString(input.tool_response).match(
    /Fetched and indexed[^\(]*\(([\d.]+)\s*KB\)/i
  );
  if (preambleMatch) {
    const kb = Number(preambleMatch[1]);
    if (Number.isFinite(kb) && kb > 0) {
      bytesAvoided = Math.round(kb * 1024);
    }
  }
  const event = {
    type: "external_ref",
    category: "external-ref",
    data: safeString(Array.from(refs).join(", ")),
    priority: 3
  };
  if (bytesAvoided !== void 0) event.bytes_avoided = bytesAvoided;
  return [event];
}
function extractWorktree(input) {
  if (input.tool_name === "EnterWorktree") {
    const name = String(input.tool_input["name"] ?? "unnamed");
    return [{
      type: "worktree",
      category: "env",
      data: safeString(`entered worktree: ${name}`),
      priority: 2
    }];
  }
  if (input.tool_name === "ExitWorktree") {
    const discard = Boolean(input.tool_input["discard_changes"]);
    return [{
      type: "worktree_exit",
      category: "env",
      data: safeString(`exited worktree (discard_changes:${discard})`),
      priority: 2
    }];
  }
  return [];
}
function extractHostFromUrl(url) {
  if (typeof url !== "string" || url.length === 0) return null;
  const protoEnd = url.indexOf("://");
  if (protoEnd < 0) return null;
  const start = protoEnd + 3;
  if (start >= url.length) return null;
  let end = url.length;
  for (let i = start; i < url.length; i++) {
    const c = url.charCodeAt(i);
    if (c === 47 || c === 63 || c === 35) {
      end = i;
      break;
    }
  }
  const host = url.slice(start, end);
  return host.length > 0 ? host : null;
}
function extractWebFetchMetadata(input) {
  if (input.tool_name !== "WebFetch") return [];
  const resp = input.tool_response;
  if (typeof resp !== "string" || resp.length === 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(resp);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const obj = parsed;
  const parts = [];
  if (typeof obj.code === "number") parts.push(`code:${obj.code}`);
  if (typeof obj.bytes === "number") parts.push(`bytes:${obj.bytes}`);
  if (typeof obj.durationMs === "number") parts.push(`durMs:${obj.durationMs}`);
  if (typeof obj.url === "string") {
    const host = extractHostFromUrl(obj.url);
    if (host) parts.push(`host:${host}`);
  }
  if (parts.length === 0) return [];
  return [{
    type: "webfetch_metadata",
    category: "data",
    data: safeString(parts.join(" ")),
    priority: 3
  }];
}
function extractBashOutcome(input) {
  if (input.tool_name !== "Bash") return [];
  const resp = input.tool_response;
  if (typeof resp !== "string" || resp.length === 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(resp);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const obj = parsed;
  const hasSignal = typeof obj.interrupted === "boolean" || typeof obj.stderr === "string" || typeof obj.returnCodeInterpretation === "string";
  if (!hasSignal) return [];
  const parts = [];
  if (typeof obj.interrupted === "boolean") {
    parts.push(`interrupted:${obj.interrupted}`);
  }
  if (typeof obj.returnCodeInterpretation === "string") {
    parts.push(`rcInterp:${obj.returnCodeInterpretation.slice(0, 80)}`);
  }
  if (typeof obj.stderr === "string") {
    parts.push(`stderrBytes:${obj.stderr.length}`);
  }
  return [{
    type: "bash_outcome",
    category: "data",
    data: safeString(parts.join(" ")),
    priority: 3
  }];
}
function extractFileReadMetadata(input) {
  if (input.tool_name !== "Read") return [];
  const resp = input.tool_response;
  if (typeof resp !== "string" || resp.length === 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(resp);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const obj = parsed;
  const variant = obj.type;
  if (variant !== "text" && variant !== "image") return [];
  const parts = [`type:${variant}`];
  if (variant === "text") {
    if (typeof obj.numLines === "number") parts.push(`lines:${obj.numLines}`);
    if (typeof obj.totalLines === "number") parts.push(`totalLines:${obj.totalLines}`);
    if (typeof obj.startLine === "number") parts.push(`start:${obj.startLine}`);
  } else {
    if (typeof obj.originalSize === "number") parts.push(`origSize:${obj.originalSize}`);
    const dims = obj.dimensions;
    if (dims && typeof dims === "object") {
      const d = dims;
      if (typeof d.width === "number" && typeof d.height === "number") {
        parts.push(`dims:${d.width}x${d.height}`);
      }
    }
  }
  return [{
    type: "file_read_metadata",
    category: "data",
    data: safeString(parts.join(" ")),
    priority: 3
  }];
}
function resolveModelId(input, parsedResp) {
  const candidates = [
    input.tool_input?.model,
    input.model,
    parsedResp.model
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return "";
}
function dropTrailingSegment(id) {
  for (let i = id.length - 1; i > 0; i--) {
    if (id.charCodeAt(i) === 45) return id.slice(0, i);
  }
  return null;
}
function resolveCatalogId(modelId) {
  let candidate = modelId;
  while (candidate && candidate.length > 0) {
    if (lookupPrice(candidate) !== null) return candidate;
    candidate = dropTrailingSegment(candidate);
  }
  return "";
}
function computeTurnCostUsd(modelId, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens) {
  const resolved = resolveCatalogId(modelId);
  return computeCostUsd(resolved || modelId, {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_tokens: cacheCreationTokens,
    cache_read_tokens: cacheReadTokens
  });
}
function formatCostUsd(cost) {
  let s = cost.toFixed(6);
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 48) end--;
  s = s.slice(0, end);
  if (s.length > 0 && s.charCodeAt(s.length - 1) === 46) s += "0";
  return s;
}
function extractAgentUsage(input) {
  if (input.tool_name !== "Task") return [];
  const resp = input.tool_response;
  if (typeof resp !== "string" || resp.length === 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(resp);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const out = parsed;
  const usage = out.usage && typeof out.usage === "object" ? out.usage : {};
  const hasSignal = typeof out.totalTokens === "number" || typeof out.totalDurationMs === "number" || typeof usage.input_tokens === "number" || typeof usage.output_tokens === "number" || typeof usage.service_tier === "string";
  if (!hasSignal) return [];
  const parts = [];
  if (typeof out.totalTokens === "number") parts.push(`totalTokens:${out.totalTokens}`);
  if (typeof out.totalDurationMs === "number") parts.push(`totalDurMs:${out.totalDurationMs}`);
  if (typeof usage.input_tokens === "number") parts.push(`tokens_in:${usage.input_tokens}`);
  if (typeof usage.output_tokens === "number") parts.push(`tokens_out:${usage.output_tokens}`);
  if (typeof usage.cache_creation_input_tokens === "number") {
    parts.push(`cache_create:${usage.cache_creation_input_tokens}`);
  }
  if (typeof usage.cache_read_input_tokens === "number") {
    parts.push(`cache_read:${usage.cache_read_input_tokens}`);
  }
  if (typeof usage.service_tier === "string") {
    parts.push(`tier:${usage.service_tier.slice(0, 32)}`);
  }
  const modelId = resolveModelId(input, out);
  const event = {
    type: "agent_usage",
    category: "cost",
    data: safeString(parts.join(" ")),
    priority: 2
  };
  if (modelId.length > 0) event.model_id = modelId;
  if (typeof usage.input_tokens === "number") event.input_tokens = usage.input_tokens;
  if (typeof usage.output_tokens === "number") event.output_tokens = usage.output_tokens;
  if (typeof usage.cache_read_input_tokens === "number") {
    event.cache_read_tokens = usage.cache_read_input_tokens;
  }
  if (typeof usage.cache_creation_input_tokens === "number") {
    event.cache_creation_tokens = usage.cache_creation_input_tokens;
  }
  event.usage_scope = "task_cumulative";
  return [event];
}
function parsePiUsage(payload) {
  if (!payload || typeof payload !== "object") return null;
  const root = payload;
  const maybeMessage = root.message;
  const message = maybeMessage && typeof maybeMessage === "object" ? maybeMessage : root;
  if (typeof message.role === "string" && message.role !== "assistant") {
    return null;
  }
  const usageRaw = message.usage;
  if (!usageRaw || typeof usageRaw !== "object") return null;
  const usage = usageRaw;
  const num = (v) => typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
  const input_tokens = num(usage.input);
  const output_tokens = num(usage.output);
  const cache_creation_tokens = num(usage.cacheWrite);
  const cache_read_tokens = num(usage.cacheRead);
  if (input_tokens <= 0 && output_tokens <= 0 && cache_creation_tokens <= 0 && cache_read_tokens <= 0) {
    return null;
  }
  let native_cost_usd = null;
  const costRaw = usage.cost;
  if (costRaw && typeof costRaw === "object") {
    const total = costRaw.total;
    if (typeof total === "number" && Number.isFinite(total)) {
      native_cost_usd = total;
    }
  }
  const model_id = typeof message.model === "string" ? message.model : "";
  return {
    model_id,
    input_tokens,
    output_tokens,
    cache_creation_tokens,
    cache_read_tokens,
    native_cost_usd
  };
}
function buildAgentUsageEvent(counts) {
  const { model_id, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, native_cost_usd } = counts;
  if (input_tokens <= 0 && output_tokens <= 0 && cache_creation_tokens <= 0 && cache_read_tokens <= 0) {
    return null;
  }
  const parts = [`tokens_in:${input_tokens}`, `tokens_out:${output_tokens}`];
  if (cache_creation_tokens > 0) parts.push(`cache_create:${cache_creation_tokens}`);
  if (cache_read_tokens > 0) parts.push(`cache_read:${cache_read_tokens}`);
  const cost = typeof native_cost_usd === "number" && Number.isFinite(native_cost_usd) ? native_cost_usd : computeTurnCostUsd(model_id, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens);
  if (cost !== null) parts.push(`cost_usd:${formatCostUsd(cost)}`);
  const event = {
    type: "agent_usage",
    category: "cost",
    data: safeString(parts.join(" ")),
    priority: 2
  };
  if (model_id.length > 0) event.model_id = model_id;
  event.input_tokens = input_tokens;
  event.output_tokens = output_tokens;
  if (cache_read_tokens > 0) event.cache_read_tokens = cache_read_tokens;
  if (cache_creation_tokens > 0) event.cache_creation_tokens = cache_creation_tokens;
  if (cost !== null) event.cost_usd = cost;
  return event;
}
var CLAUSE_SEPARATOR_PATTERN = /[,;，；、،]/u;
var DECISION_MIN_CHARS = 15;
var DECISION_MAX_CHARS = 500;
function looksLikeDecision(trimmed) {
  if (QUESTION_MARK_PATTERN.test(trimmed)) return false;
  if (!ALPHABETIC_PATTERN.test(trimmed)) return false;
  if (!CLAUSE_SEPARATOR_PATTERN.test(trimmed)) return false;
  const codepointLength = [...trimmed].length;
  return codepointLength >= DECISION_MIN_CHARS && codepointLength <= DECISION_MAX_CHARS;
}
function extractUserDecision(message) {
  const trimmed = message.trim();
  if (!looksLikeDecision(trimmed)) return [];
  return [{
    type: "decision",
    category: "decision",
    data: safeString(message),
    priority: 2
  }];
}
var ROLE_MIN_CHARS = 8;
var ROLE_MAX_CHARS = 120;
var TWO_LEXICAL_TOKENS_PATTERN = new RegExp("\\p{L}+\\s+\\p{L}+", "u");
var CONTINUOUS_LETTER_RUN_PATTERN = new RegExp("\\p{L}{6,}", "u");
var ROLE_FILLER_TOKENS = /* @__PURE__ */ new Set([
  "ok",
  "okay",
  "sure",
  "yeah",
  "yep",
  "yup",
  "alright",
  "fine",
  "well",
  "so",
  "hmm",
  "right",
  "please"
]);
var ROLE_PERSONA_PREFIXES = [
  "you are",
  "you're",
  "your role",
  "you will be",
  "you act",
  "you will act",
  "act as",
  "act like",
  "behave as",
  "behave like",
  "imagine you",
  "pretend you",
  "assume the role",
  "take the role",
  "play the role",
  "respond as",
  "tu es",
  "tu est",
  "vous etes",
  "vous \xEAtes",
  // French
  "sen ",
  "siz ",
  // Turkish (Sen kıdemli…)
  "eres ",
  "t\xFA eres",
  "usted es",
  // Spanish (Eres…)
  "\u0442\u044B ",
  "\u0432\u044B ",
  // Russian (Ты опытный…)
  "\u3042\u306A\u305F\u306F",
  "\u541B\u306F",
  "\u304A\u524D\u306F",
  "\u3042\u306A\u305F\u304C",
  // Japanese (あなたは…)
  "\u4F60\u662F",
  "\u60A8\u662F",
  // Chinese (你是…)
  "\u0924\u0941\u092E ",
  "\u0906\u092A ",
  "\u0924\u0942 ",
  // Hindi (तुम…)
  "\u0623\u0646\u062A ",
  "\u0627\u0646\u062A ",
  "\u0623\u0646\u062A\u064E "
  // Arabic (أنت…)
];
var ROLE_DIRECTIVE_PREFIXES = [
  "always ",
  "never ",
  "respond ",
  "reply ",
  "answer ",
  "speak ",
  "write ",
  "prefer ",
  "format ",
  "output ",
  "communicate ",
  "use only "
];
function hasRoleCue(firstClause) {
  const lower = firstClause.toLowerCase().trim();
  if (!lower) return false;
  const tokens = lower.split(" ").filter((t) => t.length > 0);
  while (tokens.length > 0 && ROLE_FILLER_TOKENS.has(tokens[0])) {
    tokens.shift();
  }
  const normalized = tokens.join(" ");
  if (!normalized) return false;
  for (const prefix of ROLE_PERSONA_PREFIXES) {
    if (normalized.startsWith(prefix)) return true;
  }
  for (const prefix of ROLE_DIRECTIVE_PREFIXES) {
    if (normalized.startsWith(prefix)) return true;
  }
  return false;
}
function looksLikeRole(trimmed) {
  const firstClause = trimmed.split(/[.!\n。！]/u)[0].trim();
  if (QUESTION_MARK_PATTERN.test(firstClause)) return false;
  if (CLAUSE_SEPARATOR_PATTERN.test(firstClause)) return false;
  if (!ALPHABETIC_PATTERN.test(firstClause)) return false;
  const codepointLength = [...firstClause].length;
  if (codepointLength < ROLE_MIN_CHARS || codepointLength > ROLE_MAX_CHARS) return false;
  if (!hasRoleCue(firstClause)) return false;
  return TWO_LEXICAL_TOKENS_PATTERN.test(firstClause) || CONTINUOUS_LETTER_RUN_PATTERN.test(firstClause);
}
function extractRole(message) {
  const trimmed = message.trim();
  if (!looksLikeRole(trimmed)) return [];
  return [{
    type: "role",
    category: "role",
    data: safeString(message),
    priority: 3
  }];
}
var QUESTION_MARK_PATTERN = /[?？؟¿]/u;
var ALPHABETIC_PATTERN = new RegExp("\\p{L}", "u");
var IMPERATIVE_MAX_CHARS = 60;
function isImperativeTone(trimmed) {
  if (QUESTION_MARK_PATTERN.test(trimmed)) return false;
  if (!ALPHABETIC_PATTERN.test(trimmed)) return false;
  const codepointLength = [...trimmed].length;
  return codepointLength > 0 && codepointLength < IMPERATIVE_MAX_CHARS;
}
function extractIntent(message) {
  const trimmed = message.trim();
  if (!trimmed) return [];
  let mode;
  if (QUESTION_MARK_PATTERN.test(trimmed)) {
    mode = "investigate";
  } else if (isImperativeTone(trimmed)) {
    mode = "implement";
  }
  if (!mode) return [];
  return [{
    type: "intent",
    category: "intent",
    data: safeString(mode),
    priority: 4
  }];
}
var GOAL_DIRECTIVE_PATTERN = /^(?:\/goal\s+|(?:goal|objective)\s*:\s*)(.+)$/is;
function extractGoal(message) {
  const trimmed = message.trim();
  if (!trimmed) return [];
  const match = trimmed.match(GOAL_DIRECTIVE_PATTERN);
  if (!match) return [];
  const goalText = match[1].trim();
  if (!goalText) return [];
  return [{
    type: "goal",
    category: "goal",
    data: safeString(goalText),
    priority: 4
  }];
}
var BLOCKER_MARKERS_PATTERN = /(?:\bError\s*:|\bException\s*:|\bTraceback\b|\bat\s+\S+\s*\([^)]*:\d+:\d+\))/u;
var BLOCKER_RESOLVED_CHECKMARK_PATTERN = /[✓✔✅☑🎉]/u;
var BLOCKER_RESOLVED_MARKER_PATTERN = /^\s*(?:fixed|resolved)\s*:/iu;
function extractBlocker(message) {
  const events = [];
  const isResolved = BLOCKER_RESOLVED_CHECKMARK_PATTERN.test(message) || BLOCKER_RESOLVED_MARKER_PATTERN.test(message);
  if (isResolved) {
    events.push({
      type: "blocker_resolved",
      category: "blocked-on",
      data: safeString(message),
      priority: 2
    });
    return events;
  }
  if (BLOCKER_MARKERS_PATTERN.test(message)) {
    events.push({
      type: "blocker",
      category: "blocked-on",
      data: safeString(message),
      priority: 2
    });
  }
  return events;
}
function extractData(message) {
  if (message.length <= 1024) return [];
  return [{
    type: "data",
    category: "data",
    data: safeString(message),
    priority: 4
  }];
}
var lastError = null;
function extractErrorResolution(input) {
  const { tool_name, tool_response } = input;
  const response = String(tool_response ?? "");
  if (isToolError(input)) {
    lastError = { tool: tool_name, error: response.slice(0, 200), callsSince: 0 };
    return [];
  }
  if (!lastError) return [];
  lastError.callsSince++;
  if (lastError.callsSince > 10) {
    lastError = null;
    return [];
  }
  const callSucceeded = !isToolError(input);
  if (!callSucceeded) return [];
  const sameTool = tool_name === lastError.tool;
  const editAfterReadError = lastError.tool === "Read" && (tool_name === "Edit" || tool_name === "Write" || tool_name === "apply_patch");
  if (sameTool || editAfterReadError) {
    const event = {
      type: "error_resolved",
      category: "error-resolution",
      data: safeString(`Error in ${lastError.tool}: ${lastError.error} \u2192 Fixed`),
      priority: 2
    };
    lastError = null;
    return [event];
  }
  return [];
}
var callHistory = [];
function simpleHash(str) {
  return `${str.length}:${str.slice(0, 20)}`;
}
function extractIterationLoop(input) {
  const { tool_name, tool_input } = input;
  const inputHash = simpleHash(JSON.stringify(tool_input).slice(0, 200));
  callHistory.push({ tool: tool_name, inputHash });
  if (callHistory.length > 50) {
    callHistory.splice(0, callHistory.length - 50);
  }
  if (callHistory.length < 3) return [];
  let count = 0;
  for (let i = callHistory.length - 1; i >= 0; i--) {
    if (callHistory[i].tool === tool_name && callHistory[i].inputHash === inputHash) {
      count++;
    } else {
      break;
    }
  }
  if (count >= 3) {
    callHistory.splice(callHistory.length - count);
    return [{
      type: "retry_detected",
      category: "iteration-loop",
      data: safeString(`${tool_name} called ${count} times with similar input`),
      priority: 2
    }];
  }
  return [];
}
var TOOL_NAME_NORMALIZE = {
  // Qwen Code / Gemini CLI native names
  run_shell_command: "Bash",
  read_file: "Read",
  read_many_files: "Read",
  grep_search: "Grep",
  search_file_content: "Grep",
  web_fetch: "WebFetch",
  write_file: "Write",
  edit: "Edit",
  glob: "Glob",
  todo_write: "TodoWrite",
  ask_user_question: "AskUserQuestion",
  list_directory: "LS",
  save_memory: "Memory",
  skill: "Skill",
  exit_plan_mode: "ExitPlanMode",
  agent: "Agent",
  // OpenCode native names
  bash: "Bash",
  view: "Read",
  grep: "Grep",
  fetch: "WebFetch",
  // Codex CLI
  shell: "Bash",
  shell_command: "Bash",
  exec_command: "Bash",
  "container.exec": "Bash",
  local_shell: "Bash",
  grep_files: "Grep",
  // Antigravity CLI (`agy`) native names. Keep in sync with the two other agy
  // maps: hooks/antigravity-cli/payload.mjs (normalizeAgyToolName) and
  // hooks/core/routing.mjs (TOOL_ALIASES).
  run_command: "Bash",
  view_file: "Read",
  read_url_content: "WebFetch",
  list_dir: "LS",
  search_web: "WebSearch"
};
function normalizeHookInput(input) {
  const normalized = TOOL_NAME_NORMALIZE[input.tool_name];
  if (!normalized || normalized === input.tool_name) return input;
  return { ...input, tool_name: normalized };
}
function extractEvents(rawInput) {
  try {
    const input = normalizeHookInput(rawInput);
    const events = [];
    events.push(...extractFileAndRule(input));
    events.push(...extractCwd(input));
    events.push(...extractError(input));
    events.push(...extractGit(input));
    events.push(...extractEnv(input));
    events.push(...extractTask(input));
    events.push(...extractPlan(input));
    events.push(...extractSkill(input));
    events.push(...extractSubagent(input));
    events.push(...extractMcp(input));
    events.push(...extractMcpToolCall(input));
    events.push(...extractDecision(input));
    events.push(...extractConstraint(input));
    events.push(...extractWorktree(input));
    events.push(...extractWebFetchMetadata(input));
    events.push(...extractBashOutcome(input));
    events.push(...extractFileReadMetadata(input));
    events.push(...extractAgentUsage(input));
    events.push(...extractAgentFinding(input));
    events.push(...extractExternalRef(input));
    events.push(...extractErrorResolution(input));
    events.push(...extractIterationLoop(input));
    return events;
  } catch {
    return [];
  }
}
function extractUserEvents(message) {
  try {
    const events = [];
    events.push(...extractUserPlan(message));
    events.push(...extractUserDecision(message));
    events.push(...extractRole(message));
    events.push(...extractIntent(message));
    events.push(...extractGoal(message));
    events.push(...extractBlocker(message));
    events.push(...extractData(message));
    return events;
  } catch {
    return [];
  }
}
function extractUserPlan(message) {
  if (typeof message !== "string" || message.length === 0) return [];
  let i = 0;
  while (i < message.length) {
    const c = message.charCodeAt(i);
    if (c !== 32 && c !== 9) break;
    i++;
  }
  if (i + 5 > message.length) return [];
  if (message.slice(i, i + 5) !== "/plan") return [];
  if (i + 5 < message.length) {
    const next = message.charCodeAt(i + 5);
    const isWordBoundary = next === 32 || next === 9 || next === 10 || next === 13;
    if (!isWordBoundary) return [];
  }
  const arg = message.slice(i + 5).trim();
  const detail = arg.length > 0 ? `plan via /plan slash: ${arg.slice(0, 120)}` : "plan via /plan slash";
  return [{
    type: "plan_enter",
    category: "plan",
    data: safeString(detail),
    priority: 2
  }];
}

// src/truncate.ts
function escapeXML(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// src/session/snapshot.ts
var MAX_ACTIVE_FILES = 10;
function buildQueries(items, maxQueries = 4) {
  const unique = [...new Set(items.filter((s) => s.length > 0))];
  const selected = unique.slice(0, maxQueries);
  return selected.map((s) => {
    const trimmed = s.length > 80 ? s.slice(0, 80) : s;
    return trimmed;
  });
}
function toolCall(toolName, queries) {
  if (queries.length === 0) return "";
  const escaped = queries.map((q) => `"${escapeXML(q)}"`).join(", ");
  return `
    For full details:
    ${escapeXML(toolName)}(
      queries: [${escaped}],
      source: "session-events"
    )`;
}
function buildFilesSection(fileEvents, searchTool) {
  if (fileEvents.length === 0) return "";
  const fileMap = /* @__PURE__ */ new Map();
  for (const ev of fileEvents) {
    const path = ev.data;
    let entry = fileMap.get(path);
    if (!entry) {
      entry = { ops: /* @__PURE__ */ new Map() };
      fileMap.set(path, entry);
    }
    let op;
    if (ev.type === "file_write") op = "write";
    else if (ev.type === "file_read") op = "read";
    else if (ev.type === "file_edit") op = "edit";
    else op = ev.type;
    entry.ops.set(op, (entry.ops.get(op) ?? 0) + 1);
  }
  const entries = Array.from(fileMap.entries());
  const limited = entries.slice(-MAX_ACTIVE_FILES);
  const summaryLines = [];
  const queryTerms = [];
  for (const [path, { ops }] of limited) {
    const opsStr = Array.from(ops.entries()).map(([k, v]) => `${k}\xD7${v}`).join(", ");
    const fileName = path.split("/").pop() ?? path;
    summaryLines.push(`    ${escapeXML(fileName)} (${escapeXML(opsStr)})`);
    queryTerms.push(`${fileName} ${Array.from(ops.keys()).join(" ")}`);
  }
  const queries = buildQueries(queryTerms);
  const lines = [
    `  <files count="${fileMap.size}">`,
    ...summaryLines,
    toolCall(searchTool, queries),
    `  </files>`
  ];
  return lines.join("\n");
}
function buildErrorsSection(errorEvents, searchTool) {
  if (errorEvents.length === 0) return "";
  const summaryLines = [];
  const queryTerms = [];
  for (const ev of errorEvents) {
    summaryLines.push(`    ${escapeXML(ev.data)}`);
    queryTerms.push(ev.data);
  }
  const queries = buildQueries(queryTerms);
  const lines = [
    `  <errors count="${errorEvents.length}">`,
    ...summaryLines,
    toolCall(searchTool, queries),
    `  </errors>`
  ];
  return lines.join("\n");
}
function buildDecisionsSection(decisionEvents, searchTool) {
  if (decisionEvents.length === 0) return "";
  const seen = /* @__PURE__ */ new Set();
  const summaryLines = [];
  const queryTerms = [];
  for (const ev of decisionEvents) {
    if (seen.has(ev.data)) continue;
    seen.add(ev.data);
    summaryLines.push(`    ${escapeXML(ev.data)}`);
    queryTerms.push(ev.data);
  }
  if (summaryLines.length === 0) return "";
  const queries = buildQueries(queryTerms);
  const lines = [
    `  <decisions count="${summaryLines.length}">`,
    ...summaryLines,
    toolCall(searchTool, queries),
    `  </decisions>`
  ];
  return lines.join("\n");
}
function buildRulesSection(ruleEvents, searchTool) {
  if (ruleEvents.length === 0) return "";
  const seen = /* @__PURE__ */ new Set();
  const summaryLines = [];
  const queryTerms = [];
  for (const ev of ruleEvents) {
    if (seen.has(ev.data)) continue;
    seen.add(ev.data);
    if (ev.type === "rule_content") {
      summaryLines.push(`    ${escapeXML(ev.data)}`);
    } else {
      summaryLines.push(`    ${escapeXML(ev.data)}`);
    }
    queryTerms.push(ev.data);
  }
  if (summaryLines.length === 0) return "";
  const queries = buildQueries(queryTerms);
  const lines = [
    `  <rules count="${summaryLines.length}">`,
    ...summaryLines,
    toolCall(searchTool, queries),
    `  </rules>`
  ];
  return lines.join("\n");
}
function buildGitSection(gitEvents, searchTool) {
  if (gitEvents.length === 0) return "";
  const summaryLines = [];
  const queryTerms = [];
  for (const ev of gitEvents) {
    summaryLines.push(`    ${escapeXML(ev.data)}`);
    queryTerms.push(ev.data);
  }
  const queries = buildQueries(queryTerms);
  const lines = [
    `  <git count="${gitEvents.length}">`,
    ...summaryLines,
    toolCall(searchTool, queries),
    `  </git>`
  ];
  return lines.join("\n");
}
function renderTaskState(taskEvents) {
  if (taskEvents.length === 0) return "";
  const creates = [];
  const updates = {};
  for (const ev of taskEvents) {
    try {
      const parsed = JSON.parse(ev.data);
      if (typeof parsed.subject === "string") {
        creates.push(parsed.subject);
      } else if (typeof parsed.taskId === "string" && typeof parsed.status === "string") {
        updates[parsed.taskId] = parsed.status;
      }
    } catch {
    }
  }
  if (creates.length === 0) return "";
  const DONE = /* @__PURE__ */ new Set(["completed", "deleted", "failed"]);
  const sortedIds = Object.keys(updates).sort((a, b) => Number(a) - Number(b));
  const pending = [];
  for (let i = 0; i < creates.length; i++) {
    const matchedId = sortedIds[i];
    const status = matchedId ? updates[matchedId] ?? "pending" : "pending";
    if (!DONE.has(status)) {
      pending.push(creates[i]);
    }
  }
  if (pending.length === 0) return "";
  const lines = [];
  for (const task of pending) {
    lines.push(`    [pending] ${escapeXML(task)}`);
  }
  return lines.join("\n");
}
function buildTaskSection(taskEvents, searchTool) {
  const taskContent = renderTaskState(taskEvents);
  if (!taskContent) return "";
  const queryTerms = [];
  for (const ev of taskEvents) {
    try {
      const parsed = JSON.parse(ev.data);
      if (typeof parsed.subject === "string") {
        queryTerms.push(parsed.subject);
      }
    } catch {
    }
  }
  const queries = buildQueries(queryTerms);
  const pendingCount = taskContent.split("\n").length;
  const lines = [
    `  <task_state count="${pendingCount}">`,
    taskContent,
    toolCall(searchTool, queries),
    `  </task_state>`
  ];
  return lines.join("\n");
}
function buildEnvironmentSection(cwdEvents, envEvents, searchTool) {
  if (cwdEvents.length === 0 && envEvents.length === 0) return "";
  const summaryLines = [];
  const queryTerms = [];
  if (cwdEvents.length > 0) {
    const lastCwd = cwdEvents[cwdEvents.length - 1];
    summaryLines.push(`    cwd: ${escapeXML(lastCwd.data)}`);
    queryTerms.push("working directory");
  }
  for (const env of envEvents) {
    summaryLines.push(`    ${escapeXML(env.data)}`);
    queryTerms.push(env.data);
  }
  const queries = buildQueries(queryTerms);
  const lines = [
    `  <environment>`,
    ...summaryLines,
    toolCall(searchTool, queries),
    `  </environment>`
  ];
  return lines.join("\n");
}
function buildSubagentsSection(subagentEvents, searchTool) {
  if (subagentEvents.length === 0) return "";
  const summaryLines = [];
  const queryTerms = [];
  for (const ev of subagentEvents) {
    const status = ev.type === "subagent_completed" ? "completed" : ev.type === "subagent_launched" ? "launched" : "unknown";
    summaryLines.push(`    [${status}] ${escapeXML(ev.data)}`);
    queryTerms.push(`subagent ${ev.data}`);
  }
  const queries = buildQueries(queryTerms);
  const lines = [
    `  <subagents count="${subagentEvents.length}">`,
    ...summaryLines,
    toolCall(searchTool, queries),
    `  </subagents>`
  ];
  return lines.join("\n");
}
function buildSkillsSection(skillEvents, searchTool) {
  if (skillEvents.length === 0) return "";
  const skillCounts = /* @__PURE__ */ new Map();
  for (const ev of skillEvents) {
    const name = ev.data.split(":")[0].trim();
    skillCounts.set(name, (skillCounts.get(name) ?? 0) + 1);
  }
  const summaryLines = [];
  const queryTerms = [];
  for (const [name, count] of skillCounts) {
    summaryLines.push(`    ${escapeXML(name)} (${count}\xD7)`);
    queryTerms.push(`skill ${name} invocation`);
  }
  const queries = buildQueries(queryTerms);
  const lines = [
    `  <skills count="${skillEvents.length}">`,
    ...summaryLines,
    toolCall(searchTool, queries),
    `  </skills>`
  ];
  return lines.join("\n");
}
function buildRolesSection(roleEvents, searchTool) {
  if (roleEvents.length === 0) return "";
  const seen = /* @__PURE__ */ new Set();
  const summaryLines = [];
  const queryTerms = [];
  for (const ev of roleEvents) {
    if (seen.has(ev.data)) continue;
    seen.add(ev.data);
    summaryLines.push(`    ${escapeXML(ev.data)}`);
    queryTerms.push(ev.data);
  }
  if (summaryLines.length === 0) return "";
  const queries = buildQueries(queryTerms);
  const lines = [
    `  <roles count="${summaryLines.length}">`,
    ...summaryLines,
    toolCall(searchTool, queries),
    `  </roles>`
  ];
  return lines.join("\n");
}
function buildIntentSection(intentEvents) {
  if (intentEvents.length === 0) return "";
  const lastIntent = intentEvents[intentEvents.length - 1];
  return `  <intent mode="${escapeXML(lastIntent.data)}"/>`;
}
function buildGoalSection(goalEvents) {
  if (goalEvents.length === 0) return "";
  const lastGoal = goalEvents[goalEvents.length - 1];
  return [
    `  <session_goal>`,
    `  The active objective for this session. Keep working toward it until it is met; do not ask the user to restate it.`,
    `    ${escapeXML(lastGoal.data)}`,
    `  </session_goal>`
  ].join("\n");
}
var RECENT_MESSAGES_LIMIT = 3;
var RECENT_MESSAGE_MAX_CHARS = 400;
function truncateForSnapshot(value, max) {
  const codepoints = [...value];
  if (codepoints.length <= max) return value;
  return codepoints.slice(0, max).join("");
}
function buildRecentMessagesSection(userPromptEvents) {
  if (userPromptEvents.length === 0) return "";
  const recent = userPromptEvents.slice(-RECENT_MESSAGES_LIMIT);
  const items = recent.map((ev) => {
    const body = truncateForSnapshot(ev.data ?? "", RECENT_MESSAGE_MAX_CHARS);
    if (!body) return "";
    return `    <message>${escapeXML(body)}</message>`;
  }).filter(Boolean);
  if (items.length === 0) return "";
  return [
    `  <recent_user_messages count="${items.length}">`,
    ...items,
    `  </recent_user_messages>`
  ].join("\n");
}
function buildResumeSnapshot(events, opts) {
  const compactCount = opts?.compactCount ?? 1;
  const searchTool = opts?.searchTool ?? "ctx_search";
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const fileEvents = [];
  const taskEvents = [];
  const ruleEvents = [];
  const decisionEvents = [];
  const cwdEvents = [];
  const errorEvents = [];
  const envEvents = [];
  const gitEvents = [];
  const subagentEvents = [];
  const intentEvents = [];
  const goalEvents = [];
  const skillEvents = [];
  const roleEvents = [];
  const userPromptEvents = [];
  for (const ev of events) {
    switch (ev.category) {
      case "file":
        fileEvents.push(ev);
        break;
      case "task":
        taskEvents.push(ev);
        break;
      case "rule":
        ruleEvents.push(ev);
        break;
      case "decision":
        decisionEvents.push(ev);
        break;
      case "cwd":
        cwdEvents.push(ev);
        break;
      case "error":
        errorEvents.push(ev);
        break;
      case "env":
        envEvents.push(ev);
        break;
      case "git":
        gitEvents.push(ev);
        break;
      case "subagent":
        subagentEvents.push(ev);
        break;
      case "intent":
        intentEvents.push(ev);
        break;
      case "goal":
        goalEvents.push(ev);
        break;
      case "skill":
        skillEvents.push(ev);
        break;
      case "role":
        roleEvents.push(ev);
        break;
      case "user-prompt":
        userPromptEvents.push(ev);
        break;
    }
  }
  const sections = [];
  sections.push(`  <how_to_search>
  Each section below contains a summary of prior work.
  For FULL DETAILS, run the exact tool call shown under each section.
  Do NOT ask the user to re-explain prior work. Search first.
  Do NOT invent your own queries \u2014 use the ones provided.
  </how_to_search>`);
  const goal = buildGoalSection(goalEvents);
  if (goal) sections.push(goal);
  const files = buildFilesSection(fileEvents, searchTool);
  if (files) sections.push(files);
  const errors = buildErrorsSection(errorEvents, searchTool);
  if (errors) sections.push(errors);
  const decisions = buildDecisionsSection(decisionEvents, searchTool);
  if (decisions) sections.push(decisions);
  const rules = buildRulesSection(ruleEvents, searchTool);
  if (rules) sections.push(rules);
  const git = buildGitSection(gitEvents, searchTool);
  if (git) sections.push(git);
  const tasks = buildTaskSection(taskEvents, searchTool);
  if (tasks) sections.push(tasks);
  const environment = buildEnvironmentSection(cwdEvents, envEvents, searchTool);
  if (environment) sections.push(environment);
  const subagents = buildSubagentsSection(subagentEvents, searchTool);
  if (subagents) sections.push(subagents);
  const skills = buildSkillsSection(skillEvents, searchTool);
  if (skills) sections.push(skills);
  const roles = buildRolesSection(roleEvents, searchTool);
  if (roles) sections.push(roles);
  const intent = buildIntentSection(intentEvents);
  if (intent) sections.push(intent);
  const recentMessages = buildRecentMessagesSection(userPromptEvents);
  if (recentMessages) sections.push(recentMessages);
  const header = `<session_resume events="${events.length}" compact_count="${compactCount}" generated_at="${now}">`;
  const footer = `</session_resume>`;
  const body = sections.join("\n\n");
  if (body) {
    return `${header}

${body}

${footer}`;
  }
  return `${header}
${footer}`;
}

// src/adapters/pi/mcp-bridge.ts
init_runtime();
init_credential_env();
init_detect();
import { existsSync as existsSync4 } from "node:fs";
import { join as join3 } from "node:path";
import { spawn, execSync as execSync2 } from "node:child_process";
var PI_BINARY_BASENAME = /^pi(\.exe)?$/i;
var BRIDGE_DEPTH_ENV = "CONTEXT_MODE_BRIDGE_DEPTH";
var isWindows2 = process.platform === "win32";
function basename(p) {
  const segs = p.split(/[\\/]/);
  return segs[segs.length - 1] ?? "";
}
function whichOnPath(cmd) {
  try {
    const probe = isWindows2 ? `where ${cmd}` : `command -v ${cmd}`;
    const out = execSync2(probe, {
      encoding: "utf-8",
      stdio: "pipe",
      env: safeChildProcessEnvironment()
    }).trim().split(/\r?\n/)[0]?.trim();
    return out && out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
function resolveJsRuntimeForBridge(deps = {}) {
  const detect = deps.detect ?? (() => detectRuntimes());
  const which = deps.which ?? whichOnPath;
  const execPath = deps.execPath ?? process.execPath;
  const isPi = (p) => !!p && PI_BINARY_BASENAME.test(basename(p));
  let candidate = null;
  try {
    candidate = detect().javascript ?? null;
  } catch {
    candidate = null;
  }
  if (candidate && !isPi(candidate)) return candidate;
  for (const cmd of ["node", "bun"]) {
    const resolved = which(cmd);
    if (resolved && !isPi(resolved)) return resolved;
  }
  if (execPath && !isPi(execPath)) return execPath;
  return null;
}
var DEFAULT_REQUEST_TIMEOUT_MS = 6e4;
var MAX_INIT_RETRIES = 2;
var INIT_RETRY_DELAY_MS = 1e3;
var PiTextComponent = class {
  text;
  constructor(text = "") {
    this.text = text;
  }
  setText(text) {
    this.text = text;
  }
  invalidate() {
  }
  render(width) {
    if (!this.text || this.text.trim() === "") return [];
    return this.text.replace(/\t/g, "   ").split(/\r?\n/).map((line) => truncateAnsiLine(line, Math.max(1, width)));
  }
};
var GRAPHEME_SEGMENTER = new Intl.Segmenter(void 0, { granularity: "grapheme" });
function extractTerminalEscape(str, pos) {
  if (pos >= str.length || str[pos] !== "\x1B") return null;
  const next = str[pos + 1];
  if (next === "[") {
    let j = pos + 2;
    while (j < str.length) {
      const code = str.charCodeAt(j);
      if (code >= 64 && code <= 126) {
        return { code: str.slice(pos, j + 1), length: j + 1 - pos };
      }
      j++;
    }
    return null;
  }
  if (next === "]" || next === "_") {
    let j = pos + 2;
    while (j < str.length) {
      if (str[j] === "\x07") return { code: str.slice(pos, j + 1), length: j + 1 - pos };
      if (str[j] === "\x1B" && str[j + 1] === "\\") {
        return { code: str.slice(pos, j + 2), length: j + 2 - pos };
      }
      j++;
    }
    return null;
  }
  return null;
}
function couldBeEmoji(segment) {
  const cp = segment.codePointAt(0) ?? 0;
  return cp >= 126976 && cp <= 130047 || cp >= 8960 && cp <= 9215 || cp >= 9728 && cp <= 10175 || cp >= 11088 && cp <= 11093 || segment.includes("\uFE0F") || segment.includes("\u200D");
}
function isZeroWidthCodePoint(cp) {
  return cp < 32 || cp >= 127 && cp <= 159 || cp >= 768 && cp <= 879 || // Combining Diacritical Marks
  cp >= 6832 && cp <= 6911 || // Combining Diacritical Marks Extended
  cp >= 7616 && cp <= 7679 || // Combining Diacritical Marks Supplement
  cp >= 8400 && cp <= 8447 || // Combining Diacritical Marks for Symbols
  cp >= 65024 && cp <= 65039 || // Variation Selectors
  cp >= 65056 && cp <= 65071 || // Combining Half Marks
  cp === 8203 || cp === 8204 || cp === 8205 || cp === 65279;
}
function isZeroWidthGrapheme(segment) {
  if (segment.length === 0) return true;
  for (const char of segment) {
    if (!isZeroWidthCodePoint(char.codePointAt(0) ?? 0)) return false;
  }
  return true;
}
function charWidth(cp) {
  return cp >= 4352 && (cp <= 4447 || // Hangul Jamo
  cp >= 43360 && cp <= 43388 || // Hangul Jamo Extended-A
  cp === 9001 || cp === 9002 || cp >= 11904 && cp <= 42191 && cp !== 12351 || // CJK
  cp >= 44032 && cp <= 55203 || // Hangul syllables
  cp >= 55216 && cp <= 55291 || // Hangul Jamo Extended-B
  cp >= 63744 && cp <= 64255 || // CJK compat
  cp >= 65040 && cp <= 65049 || // Vertical forms
  cp >= 65072 && cp <= 65135 || // CJK compat forms
  cp >= 65281 && cp <= 65376 || // Fullwidth forms
  cp >= 65504 && cp <= 65510 || // Fullwidth signs
  cp >= 131072 && cp <= 196605 || // CJK extensions
  cp >= 196608 && cp <= 262141) ? 2 : 1;
}
function graphemeWidth(segment) {
  const cp = segment.codePointAt(0);
  if (cp === void 0) return 0;
  if (isZeroWidthGrapheme(segment)) return 0;
  if (couldBeEmoji(segment)) return 2;
  if (cp >= 127462 && cp <= 127487) return 2;
  return charWidth(cp);
}
function truncateAnsiLine(line, maxWidth) {
  if (maxWidth <= 0) return "";
  let output = "";
  let visible = 0;
  let index = 0;
  while (index < line.length) {
    const escape = extractTerminalEscape(line, index);
    if (escape) {
      output += escape.code;
      index += escape.length;
      continue;
    }
    let end = index + 1;
    while (end < line.length && !extractTerminalEscape(line, end)) end++;
    const chunk = line.slice(index, end);
    for (const { segment } of GRAPHEME_SEGMENTER.segment(chunk)) {
      const w = graphemeWidth(segment);
      if (visible + w > maxWidth) return output;
      output += segment;
      visible += w;
    }
    index = end;
  }
  return output;
}
function createContextModeCallRenderer(toolName) {
  return (_args, theme, context) => {
    const text = context.lastComponent instanceof PiTextComponent ? context.lastComponent : new PiTextComponent();
    text.setText(theme.fg("toolTitle", theme.bold(toolName)));
    return text;
  };
}
function createContextModeResultRenderer(toolName) {
  return (result, { expanded, isPartial }, theme, context) => {
    const text = context.lastComponent instanceof PiTextComponent ? context.lastComponent : new PiTextComponent();
    if (isPartial) {
      text.setText(theme.fg("warning", "indexing/searching..."));
      return text;
    }
    const output = (result.content ?? []).filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n");
    if (expanded) {
      text.setText(theme.fg("toolOutput", output));
      return text;
    }
    const firstLine = output.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
    const status = firstLine && firstLine.length <= 180 ? firstLine : `${toolName} completed`;
    text.setText(theme.fg("toolOutput", status));
    return text;
  };
}
var MCPStdioClient = class {
  constructor(serverScript, env = process.env, runtimeOverride = null, diag = () => {
  }) {
    this.serverScript = serverScript;
    this.env = env;
    this.runtimeOverride = runtimeOverride;
    this.diag = diag;
  }
  serverScript;
  env;
  runtimeOverride;
  diag;
  child = null;
  requestId = 0;
  pending = /* @__PURE__ */ new Map();
  buffer = "";
  initialized = false;
  exited = false;
  /**
   * In-flight respawn promise — set while {@link respawn} runs so
   * concurrent callers awaiting `request()` after an idle exit observe
   * the SAME respawn, not N parallel ones. Without this guard, two
   * simultaneous `callTool` calls would each see `this.exited === true`,
   * each fire their own `respawn()`, and the loser leaks an orphaned
   * child process the GC cannot reach (no `.kill()` reference).
   */
  respawnPromise = null;
  /**
   * Live env passed to the spawned child — exposed (read-only intent)
   * so tests can pin the fork-bomb-prevention env counter (#516)
   * without needing to attach a process-tree probe.
   */
  _spawnEnv = null;
  /** Spawn the MCP child. Idempotent. */
  start() {
    if (this.child) return;
    this.exited = false;
    const runtime = this.runtimeOverride ?? resolveJsRuntimeForBridge() ?? process.execPath;
    const depth = Number.parseInt(this.env[BRIDGE_DEPTH_ENV] ?? "0", 10);
    const childEnv = {
      ...safeChildProcessEnvironment(this.env),
      [BRIDGE_DEPTH_ENV]: String(Number.isFinite(depth) ? depth + 1 : 1),
      // Local vendor policy: every bridge child must reject loopback/private
      // fetch targets. Do not trust an inherited CTX_FETCH_STRICT=0 value.
      CTX_FETCH_STRICT: "1"
    };
    for (const banned of foreignWorkspaceEnv("pi")) {
      delete childEnv[banned];
    }
    for (const banned of foreignIdentificationEnv("pi")) {
      delete childEnv[banned];
    }
    if (!childEnv.PI_CONFIG_DIR) {
      const home = childEnv.HOME ?? childEnv.USERPROFILE ?? childEnv.HOMEPATH;
      const appData = childEnv.APPDATA;
      const candidates = [];
      if (home) candidates.push(join3(home, ".pi"));
      if (appData) candidates.push(join3(appData, ".pi"));
      for (const candidate of candidates) {
        if (existsSync4(candidate)) {
          childEnv.PI_CONFIG_DIR = candidate;
          break;
        }
      }
    }
    this._spawnEnv = childEnv;
    this.child = spawn(runtime, [this.serverScript], {
      // Pipe stderr (#472 round-3): swallowing it via "ignore" hides
      // server crash diagnostics — the user only saw "ctx_* tools will
      // not be callable" with no clue WHY. We capture it so the diagnostic
      // is preserved, but route it through `diag` (Pi's file logger), NOT
      // process.stderr — Pi's raw-mode TUI owns the terminal and any console
      // write is rendered into the editor input box, blocking typing (#868).
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv
    });
    this.child.stdout?.on("data", (chunk) => this.onData(chunk));
    this.child.stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf-8");
      for (const line of splitDiagLines(text)) {
        if (line !== "") this.diag(`[mcp-bridge] ${line}`, "debug");
      }
    });
    this.child.on("exit", () => this.onExit());
    this.child.on("error", () => this.onExit());
  }
  onExit() {
    if (this.exited) return;
    this.exited = true;
    const err = new Error("MCP server exited");
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }
  onData(chunk) {
    this.buffer += chunk.toString("utf-8");
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.id !== "number" || !this.pending.has(msg.id)) continue;
      const handler = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) handler.reject(msg.error);
      else handler.resolve(msg.result);
    }
  }
  async request(method, params, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    if (this.exited) {
      if (!this.respawnPromise) {
        this.respawnPromise = this.respawn().finally(() => {
          this.respawnPromise = null;
        });
      }
      await this.respawnPromise;
    }
    if (!this.child) throw new Error("MCP client not started");
    const id = ++this.requestId;
    return new Promise((resolve5, reject) => {
      const timer = Number.isFinite(timeoutMs) ? setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`MCP request timeout after ${timeoutMs}ms: ${method}`));
      }, timeoutMs) : null;
      this.pending.set(id, {
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve5(v);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        }
      });
      const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      const rejectWrite = (err) => {
        const handler = this.pending.get(id);
        if (handler) {
          this.pending.delete(id);
          handler.reject(err);
          return;
        }
        reject(err);
      };
      this.writeFrame(frame, rejectWrite);
    });
  }
  writeFrame(frame, onError) {
    if (!this.child || this.exited) {
      onError?.(new Error("MCP server exited"));
      return false;
    }
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded || stdin.closed) {
      this.onExit();
      onError?.(new Error("MCP server stdin unavailable"));
      return false;
    }
    try {
      stdin.write(frame + "\n", (err) => {
        if (!err) return;
        const code = err.code;
        if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") {
          this.onExit();
          onError?.(err);
          return;
        }
        onError?.(err);
      });
      return true;
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? err.code : void 0;
      if (err instanceof Error && (code === "EPIPE" || code === "ERR_STREAM_DESTROYED")) {
        this.onExit();
        onError?.(err);
        return false;
      }
      throw err;
    }
  }
  notify(method, params) {
    if (!this.child) return;
    const frame = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.writeFrame(frame);
  }
  async initialize() {
    if (this.initialized) return;
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      clientInfo: {
        name: "pi-coding-agent-context-mode-bridge",
        version: "1.0"
      }
    });
    this.notify("notifications/initialized", {});
    this.initialized = true;
  }
  async listTools() {
    const result = await this.request("tools/list", {});
    return Array.isArray(result.tools) ? result.tools : [];
  }
  async callTool(name, args) {
    return this.request(
      "tools/call",
      { name, arguments: args ?? {} },
      Number.POSITIVE_INFINITY
    );
  }
  /**
   * Respawn the MCP child after an exit (clean shutdown or crash).
   * Resets state so a fresh `start()` + `initialize()` cycle runs, then
   * the caller's pending request flows through the new child.
   *
   * Single-flight — concurrent callers share one in-flight respawn via
   * {@link respawnPromise}. Internal — only entered via {@link request}.
   *
   * Sequencing pinned (do not reorder without updating the regression
   * test in tests/adapters/pi-mcp-bridge.test.ts):
   *   1. `this.child = null`     — drop stale handle
   *   2. `this.buffer = ""`       — discard leftover bytes from old child
   *   3. `this.exited = false`    — must precede `start()` + `initialize()`,
   *                                 because `request("initialize", …)`
   *                                 inside `initialize()` re-checks this
   *                                 flag and would otherwise re-enter
   *                                 respawn in an infinite loop
   *   4. `this.initialized = false`
   *   5. `this.start()`
   *   6. `await this.initialize()` — flows through `request()` recursively
   */
  async respawn() {
    this.child = null;
    this.buffer = "";
    this.exited = false;
    this.initialized = false;
    this.start();
    await this.initialize();
  }
  shutdown() {
    if (!this.child) return;
    const child = this.child;
    try {
      child.kill("SIGTERM");
    } catch {
    }
    setTimeout(() => {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      } catch {
      }
    }, 5e3).unref();
    this.child = null;
    this.initialized = false;
    this.exited = true;
  }
};
function makeBridgeDiag(pi) {
  const logger = pi?.logger;
  return (line, level = "warn") => {
    try {
      const fn = level === "debug" ? logger?.debug : logger?.warn;
      if (typeof fn === "function") fn(line);
    } catch {
    }
  };
}
function splitDiagLines(text) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      let end = i;
      if (end > start && text[end - 1] === "\r") end--;
      lines.push(text.slice(start, end));
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}
function isForegroundSession(ctx) {
  const hasUI = ctx?.hasUI;
  return hasUI !== false;
}
function foregroundBridgeEnv(baseEnv, foreground) {
  if (!foreground) return baseEnv;
  return { ...baseEnv, CONTEXT_MODE_BRIDGE_IDLE_MS: "0" };
}
function skippedBridge() {
  return {
    tools: [],
    shutdown: () => {
    },
    client: new MCPStdioClient("/dev/null")
  };
}
async function bootstrapMCPTools(pi, serverScript, options = {}) {
  const env = options.env ?? process.env;
  const diag = makeBridgeDiag(pi);
  const depth = Number.parseInt(env[BRIDGE_DEPTH_ENV] ?? "0", 10);
  if (Number.isFinite(depth) && depth > 0) {
    diag(
      `[context-mode] WARNING: skipping MCP bridge \u2014 ${BRIDGE_DEPTH_ENV}=${depth} indicates recursion (fork-bomb guard, #516). ctx_* tools will not be callable.`
    );
    return skippedBridge();
  }
  const runtime = (options._resolveJsRuntime ?? resolveJsRuntimeForBridge)();
  if (runtime === null) {
    diag(
      `[context-mode] WARNING: no JS runtime found (need node or bun on PATH). Skipping MCP bridge to avoid fork bomb (#516). ctx_* tools will not be callable.`
    );
    return skippedBridge();
  }
  const spawnEnv = foregroundBridgeEnv(env, options.foreground ?? false);
  const client = new MCPStdioClient(serverScript, spawnEnv, runtime, diag);
  let lastError2;
  for (let attempt = 0; attempt <= MAX_INIT_RETRIES; attempt++) {
    try {
      client.start();
      await client.initialize();
      lastError2 = void 0;
      break;
    } catch (err) {
      lastError2 = err;
      if (attempt === MAX_INIT_RETRIES) break;
      const msg = err instanceof Error ? err.message : String(err);
      diag(
        `[context-mode] WARNING: MCP bridge initialize failed (attempt ${attempt + 1}/${MAX_INIT_RETRIES + 1}): ${msg}. Retrying\u2026`
      );
      try {
        client.shutdown();
      } catch {
      }
      await new Promise((resolve5) => setTimeout(resolve5, INIT_RETRY_DELAY_MS));
    }
  }
  if (lastError2 !== void 0) throw lastError2;
  const tools = await client.listTools();
  const registered = [];
  for (const tool of tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description ?? "",
      // MCP tools/list returns JSON Schema; Pi validates against JSON
      // Schema (TypeBox is just JSON Schema with extra Symbol metadata
      // for type inference). Empty-object fallback keeps tools that
      // declare no parameters callable.
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
      renderCall: createContextModeCallRenderer(tool.name),
      renderResult: createContextModeResultRenderer(tool.name),
      async execute(_toolCallId, params) {
        const result = await client.callTool(tool.name, params ?? {});
        const text = (result.content ?? []).filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n");
        if (result.isError) {
          throw new Error(text || `${tool.name} returned an error`);
        }
        return {
          content: [{ type: "text", text }],
          details: {}
        };
      }
    });
    registered.push(tool.name);
  }
  return {
    tools: registered,
    shutdown: () => client.shutdown(),
    client
  };
}

// src/adapters/pi/extension.ts
init_index();
var PI_TOOL_MAP = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  grep: "Grep",
  find: "Glob",
  ls: "Glob"
};
var BLOCKED_HTTP_PATTERNS = [
  /\bfetch\s*\(/,
  /\brequests\.get\s*\(/,
  /\brequests\.post\s*\(/,
  /\bhttp\.get\s*\(/,
  /\bhttp\.request\s*\(/,
  /\burllib\.request/,
  /\bInvoke-WebRequest\b/
];
function stripQuotedContent(cmd) {
  return cmd.replace(/<<-?\s*["']?(\w+)["']?[\s\S]*?\n\s*\1/g, "").replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}
function isSafeCurlWget(segment) {
  const s = segment.trim();
  const isCurl = /\bcurl\b/i.test(s);
  const isWget = /\bwget\b/i.test(s);
  if (!isCurl && !isWget) return true;
  const hasFileOutput = isCurl ? /\s(-o|--output)\s/.test(s) || /\s>\s*/.test(s) || /\s>>\s*/.test(s) : /\s(-O|--output-document)\s/.test(s) || /\s>\s*/.test(s) || /\s>>\s*/.test(s);
  if (!hasFileOutput) return false;
  if (isCurl && /\s(-o|--output)\s+(-|\/dev\/stdout)(\s|$)/.test(s))
    return false;
  if (isWget && /\s(-O|--output-document)\s+(-|\/dev\/stdout)(\s|$)/.test(s))
    return false;
  if (/\s(-v|--verbose|--trace)\b/.test(s)) return false;
  const isSilent = isCurl ? /\s-[a-zA-Z]*s|--silent/.test(s) : /\s-[a-zA-Z]*q|--quiet/.test(s);
  return isSilent;
}
var _db = null;
var _dbPath = "";
var _sessionId = "";
var _mcpBridge = null;
var _mcpBridgeReady = Promise.resolve();
var _buildAutoInjection = void 0;
var _pendingContext = "";
async function getAutoInjection(pluginRoot) {
  if (_buildAutoInjection !== void 0) return _buildAutoInjection;
  try {
    const mod = await import(pathToFileURL(join5(pluginRoot, "hooks", "auto-injection.mjs")).href);
    _buildAutoInjection = mod.buildAutoInjection;
  } catch {
    _buildAutoInjection = null;
  }
  return _buildAutoInjection ?? null;
}
var _piAdapter = new PiAdapter();
function getSessionDir() {
  const dir = _piAdapter.getSessionDir();
  mkdirSync4(dir, { recursive: true });
  return dir;
}
function getDBPath(projectDir) {
  return resolveSessionDbPath({ projectDir, sessionsDir: getSessionDir() });
}
function getOrCreateDB(projectDir) {
  const dbPath = getDBPath(projectDir);
  if (!_db || _dbPath !== dbPath) {
    if (_db) {
      try {
        _db.close();
      } catch {
      }
    }
    _db = new SessionDB({ dbPath });
    _dbPath = dbPath;
  }
  return _db;
}
function deriveSessionId(ctx) {
  try {
    const sessionManager = ctx.sessionManager;
    const sessionFile = sessionManager?.getSessionFile?.();
    if (sessionFile && typeof sessionFile === "string") {
      return createHash2("sha256").update(sessionFile).digest("hex").slice(0, 16);
    }
  } catch {
  }
  return `pi-${Date.now()}`;
}
function parseSessionTimestampMs(value) {
  const trimmed = value.trim();
  const sqliteUtc = trimmed.match(
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?$/
  );
  const normalized = sqliteUtc ? `${sqliteUtc[1]}T${sqliteUtc[2]}${sqliteUtc[3] ?? ""}Z` : trimmed;
  return Date.parse(normalized);
}
function buildStatsText(db, sessionId) {
  try {
    const events = db.getEvents(sessionId);
    const stats = db.getSessionStats(sessionId);
    const lines = [
      "## context-mode stats (Pi)",
      "",
      `- Session: \`${sessionId.slice(0, 8)}...\``,
      `- Events captured: ${events.length}`,
      `- Compactions: ${stats?.compact_count ?? 0}`
    ];
    const byCategory = {};
    for (const ev of events) {
      const key = ev.category ?? "unknown";
      byCategory[key] = (byCategory[key] ?? 0) + 1;
    }
    if (Object.keys(byCategory).length > 0) {
      lines.push("- Event breakdown:");
      for (const [category, count] of Object.entries(byCategory)) {
        lines.push(`  - ${category}: ${count}`);
      }
    }
    if (stats?.started_at) {
      const startedMs = parseSessionTimestampMs(stats.started_at);
      if (Number.isFinite(startedMs)) {
        const ageMinutes = Math.round((Date.now() - startedMs) / 6e4);
        lines.push(`- Session age: ${ageMinutes}m`);
      }
    }
    return lines.join("\n");
  } catch {
    return "context-mode stats unavailable (session DB error)";
  }
}
function resolveCommandContext(argsOrCtx, ctx) {
  if (ctx !== void 0) return ctx;
  if (argsOrCtx && typeof argsOrCtx === "object") return argsOrCtx;
  return void 0;
}
function handleCommandText(text, ctx) {
  if (ctx?.hasUI) {
    ctx.ui.notify(text, "info");
    return;
  }
  return { text };
}
function startPiMCPBridge(pi, serverBundle, shouldKeepHandle, foreground) {
  if (existsSync5(serverBundle)) {
    _mcpBridgeReady = bootstrapMCPTools(pi, serverBundle, { foreground }).then(
      (handle) => {
        if (shouldKeepHandle()) {
          _mcpBridge = handle;
        } else {
          try {
            handle.shutdown();
          } catch {
          }
        }
      },
      (err) => {
        if (!shouldKeepHandle()) return;
        const msg = err instanceof Error ? err.message : String(err);
        makeBridgeDiag(pi)(
          `[context-mode] WARNING: failed to bridge MCP tools to Pi (${msg}). ctx_* tools will not be callable from this session.`
        );
      }
    );
  } else {
    _mcpBridgeReady = Promise.resolve();
  }
  return _mcpBridgeReady;
}
function resolvePiWorkspaceDir(opts) {
  const home = opts.home ?? homedir3();
  const piConfigDir = join5(home, ".pi");
  const isUnderPi = (p) => {
    if (!p) return true;
    if (p === piConfigDir) return true;
    return p.startsWith(piConfigDir + "/") || p.startsWith(piConfigDir + "\\");
  };
  const candidates = [
    opts.env.PI_WORKSPACE_DIR,
    opts.env.PI_PROJECT_DIR,
    opts.pwd,
    opts.cwd
  ];
  for (const c of candidates) {
    if (c && !isUnderPi(c)) return c;
  }
  return home;
}
function piExtension(pi) {
  const buildDir = dirname3(fileURLToPath(import.meta.url));
  const pluginRoot = resolve4(buildDir, "..", "..", "..");
  const serverBundle = resolve4(pluginRoot, "server.bundle.mjs");
  let mcpBridgeStarted = false;
  let mcpBridgeGeneration = 0;
  const ensureMCPBridge = (foreground) => {
    if (mcpBridgeStarted) return _mcpBridgeReady;
    mcpBridgeStarted = true;
    const generation = ++mcpBridgeGeneration;
    return startPiMCPBridge(
      pi,
      serverBundle,
      () => mcpBridgeStarted && mcpBridgeGeneration === generation,
      foreground
    );
  };
  const projectDir = resolvePiWorkspaceDir({
    env: process.env,
    pwd: process.env.PWD,
    cwd: process.cwd()
  });
  const _attribution = { projectDir, source: "workspace_root", confidence: 0.98 };
  const db = getOrCreateDB(projectDir);
  pi.on("session_start", (_event, ctx) => {
    try {
      _sessionId = deriveSessionId(ctx ?? {});
      db.ensureSession(_sessionId, projectDir);
    } catch {
      if (!_sessionId) {
        _sessionId = `pi-${Date.now()}`;
      }
    }
  });
  pi.on("tool_call", (event) => {
    try {
      const toolName = String(event?.toolName ?? "").toLowerCase();
      if (toolName !== "bash") return;
      const command = String(event?.input?.command ?? "");
      if (!command) return;
      const stripped = stripQuotedContent(command);
      if (BLOCKED_HTTP_PATTERNS.some((p) => p.test(stripped))) {
        return {
          block: true,
          reason: "Use context-mode MCP tools (execute, fetch_and_index) instead of inline HTTP clients. Raw fetch/requests/http output floods the context window."
        };
      }
      if (/(^|\s|&&|\||\;)(curl|wget)\s/i.test(stripped)) {
        const segments = stripped.split(/\s*(?:&&|\|\||;)\s*/);
        const hasUnsafeSegment = segments.some((seg) => !isSafeCurlWget(seg));
        if (hasUnsafeSegment) {
          return {
            block: true,
            reason: "Use context-mode MCP tools (execute, fetch_and_index) instead of inline HTTP clients. Raw curl/wget output floods the context window. For an MCP-down escape hatch, use silent + file output: `curl -s -o /tmp/x.json URL` or `wget -q -O /tmp/x.json URL`."
          };
        }
      }
    } catch {
    }
  });
  pi.on("tool_result", (event) => {
    try {
      if (!_sessionId) return;
      const rawToolName = String(event?.toolName ?? event?.tool_name ?? "");
      let mappedToolName = PI_TOOL_MAP[rawToolName.toLowerCase()] ?? rawToolName;
      if (/^context_mode_/.test(rawToolName)) {
        mappedToolName = rawToolName.replace(/^context_mode_/, "mcp__context_mode__");
      }
      const rawResult = event?.result ?? event?.output;
      const resultStr = typeof rawResult === "string" ? rawResult : rawResult != null ? JSON.stringify(rawResult) : void 0;
      const hasError = Boolean(event?.error || event?.isError);
      const rawInput = { ...event?.params ?? event?.input ?? {} };
      if (rawInput.path !== void 0 && rawInput.file_path === void 0) {
        rawInput.file_path = String(rawInput.path);
      }
      const hookInput = {
        tool_name: mappedToolName,
        tool_input: rawInput,
        tool_response: resultStr,
        tool_output: hasError ? { isError: true } : void 0
      };
      const events = extractEvents(hookInput);
      if (events.length > 0) {
        for (const ev of events) {
          db.insertEvent(_sessionId, ev, "PostToolUse", _attribution);
        }
      } else if (rawToolName) {
        const data = JSON.stringify({
          tool: rawToolName,
          params: event?.params ?? event?.input
        });
        db.insertEvent(
          _sessionId,
          {
            type: "tool_call",
            category: "pi",
            data,
            priority: 1,
            data_hash: createHash2("sha256").update(data).digest("hex").slice(0, 16)
          },
          "PostToolUse",
          _attribution
        );
      }
    } catch {
    }
  });
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      _pendingContext = "";
      await ensureMCPBridge(isForegroundSession(ctx));
      if (!_sessionId) return;
      const prompt = String(event?.prompt ?? "");
      if (prompt) {
        const userEvents = extractUserEvents(prompt);
        for (const ev of userEvents) {
          db.insertEvent(_sessionId, ev, "UserPromptSubmit", _attribution);
        }
      }
      const existingPrompt = String(event?.systemPrompt ?? "");
      const parts = [];
      if (existingPrompt) parts.push(existingPrompt);
      parts.push(
        "context-mode active. Hierarchy: ctx_batch_execute > ctx_execute > ctx_execute_file > ctx_search. Read/edit files \u2192 ctx_execute_file. Multi-command research \u2192 ctx_batch_execute. Web pages \u2192 ctx_fetch_and_index then ctx_search. Index docs \u2192 ctx_index. Stats \u2192 ctx_stats. Doctor \u2192 ctx_doctor."
      );
      const activeEvents = db.getEvents(_sessionId, {
        minPriority: 3,
        limit: 50
      }).filter((e) => String(e.category ?? "") !== "role");
      if (activeEvents.length > 0) {
        const buildAuto = await getAutoInjection(pluginRoot);
        let memoryContext = "";
        if (buildAuto) {
          memoryContext = buildAuto(
            activeEvents.map((e) => ({
              category: String(e.category ?? ""),
              data: String(e.data ?? "")
            }))
          );
        }
        if (!memoryContext) {
          const memoryLines = ["<active_memory>"];
          let budget = 2e3;
          for (const ev of activeEvents) {
            const line = `  <event type="${ev.type}" category="${ev.category}">${ev.data}</event>`;
            if (line.length > budget) break;
            memoryLines.push(line);
            budget -= line.length;
          }
          memoryLines.push("</active_memory>");
          if (memoryLines.length > 2) memoryContext = memoryLines.join("\n");
        }
        if (memoryContext) parts.push(memoryContext);
      }
      const resume = db.getResume(_sessionId);
      if (resume && !resume.consumed && resume.snapshot) {
        parts.push(resume.snapshot);
        db.markResumeConsumed(_sessionId);
      }
      const baseLen = existingPrompt ? 1 : 0;
      if (parts.length > baseLen) {
        const extraParts = parts.slice(baseLen);
        _pendingContext = extraParts.join("\n\n");
      } else {
        _pendingContext = "";
      }
    } catch {
      _pendingContext = "";
    }
  });
  pi.on("context", (event) => {
    try {
      if (!_pendingContext) return;
      const ctx = _pendingContext;
      _pendingContext = "";
      event.messages.push({
        role: "user",
        content: ctx
      });
      return { messages: event.messages };
    } catch {
    }
  });
  pi.on("before_provider_response", (event) => {
    try {
      if (!_sessionId) return;
      const meta = {
        model: event?.model ?? event?.providerModel,
        provider: event?.provider,
        latencyMs: event?.latencyMs ?? event?.latency,
        tokens: event?.usage ?? event?.tokens
      };
      if (meta.model == null && meta.provider == null && meta.latencyMs == null && meta.tokens == null) {
        return;
      }
      const data = JSON.stringify(meta);
      db.insertEvent(
        _sessionId,
        {
          type: "provider_response",
          category: "pi",
          data,
          priority: 1,
          data_hash: createHash2("sha256").update(data).digest("hex").slice(0, 16)
        },
        "PostToolUse",
        _attribution
      );
    } catch {
    }
  });
  pi.on("turn_end", (event) => {
    try {
      if (!_sessionId) return;
      const counts = parsePiUsage(event);
      if (!counts) return;
      const ev = buildAgentUsageEvent(counts);
      if (!ev) return;
      db.insertEvent(_sessionId, ev, "Stop", _attribution);
    } catch {
    }
  });
  pi.on("session_before_compact", () => {
    try {
      if (!_sessionId) return;
      const allEvents = db.getEvents(_sessionId);
      if (allEvents.length === 0) return;
      const stats = db.getSessionStats(_sessionId);
      const snapshot = buildResumeSnapshot(allEvents, {
        compactCount: (stats?.compact_count ?? 0) + 1
      });
      db.upsertResume(_sessionId, snapshot, allEvents.length);
    } catch {
    }
  });
  pi.on("session_compact", () => {
    try {
      if (!_sessionId) return;
      db.incrementCompactCount(_sessionId);
    } catch {
    }
  });
  pi.on("session_shutdown", async () => {
    try {
      _db = null;
      _dbPath = "";
      _sessionId = "";
    } catch {
    }
    mcpBridgeGeneration++;
    mcpBridgeStarted = false;
    try {
      await Promise.race([
        _mcpBridgeReady,
        new Promise((r) => setTimeout(r, 2e3).unref())
      ]);
    } catch {
    }
    if (_mcpBridge) {
      try {
        _mcpBridge.shutdown();
      } catch {
      }
      _mcpBridge = null;
    }
    _mcpBridgeReady = Promise.resolve();
  });
  pi.registerCommand("ctx-stats", {
    description: "Show context-mode session statistics",
    handler: async (argsOrCtx, maybeCtx) => {
      const ctx = resolveCommandContext(argsOrCtx, maybeCtx);
      const text = !_db || !_sessionId ? "context-mode: no active session" : buildStatsText(_db, _sessionId);
      return handleCommandText(text, ctx);
    }
  });
  pi.registerCommand("ctx-doctor", {
    description: "Run context-mode diagnostics",
    handler: async (argsOrCtx, maybeCtx) => {
      const ctx = resolveCommandContext(argsOrCtx, maybeCtx);
      const dbPath = getDBPath(projectDir);
      const dbExists = existsSync5(dbPath);
      const lines = [
        "## ctx-doctor (Pi)",
        "",
        `- DB path: \`${dbPath}\``,
        `- DB exists: ${dbExists}`,
        `- Session ID: \`${_sessionId ? _sessionId.slice(0, 8) + "..." : "none"}\``,
        `- Plugin root: \`${pluginRoot}\``,
        `- Project dir: \`${projectDir}\``
      ];
      if (_db && _sessionId) {
        try {
          const stats = _db.getSessionStats(_sessionId);
          const eventCount = _db.getEventCount(_sessionId);
          lines.push(`- Events: ${eventCount}`);
          lines.push(`- Compactions: ${stats?.compact_count ?? 0}`);
          const resume = _db.getResume(_sessionId);
          lines.push(
            `- Resume snapshot: ${resume ? resume.consumed ? "consumed" : "available" : "none"}`
          );
        } catch {
          lines.push("- DB query error");
        }
      }
      const text = lines.join("\n");
      return handleCommandText(text, ctx);
    }
  });
  _mcpBridgeReady = Promise.resolve();
}
export {
  _mcpBridgeReady,
  piExtension as default,
  isSafeCurlWget,
  resolvePiWorkspaceDir,
  stripQuotedContent
};
