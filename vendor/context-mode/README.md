# context-mode (vendored)

This directory contains the reviewed `context-mode@1.0.169` runtime used by
this Pi package. It is loaded from the committed files here; it does not check
for, download, install, or activate newer releases at runtime.

The active Pi entry point is `build/adapters/pi/extension.js`. It starts the
committed `server.bundle.mjs` only when an agent turn begins. The exact patched
TypeScript used to produce both artifacts is retained under `source/` for
review. `UPSTREAM-README.md` is informational upstream documentation and does
not override this repository's vendor policy.

## Local security policy

- `ctx_upgrade`, `ctx_insight`, and `ctx_purge` are not registered.
- The npm version check, hourly registry request, and Claude plugin-cache
  symlink repair are removed.
- Pi always starts the MCP child with `CTX_FETCH_STRICT=1`, so loopback,
  private, link-local, multicast, and reserved fetch targets are rejected.
- Every active child-process boundary (runtime and Git probes, MCP server,
  compiler, cleanup utility, and code launched by `ctx_execute`) removes common
  API-key, token, secret, password, cookie, database credential, Kubernetes,
  SSH-agent, authenticated proxy, and environment-based code-injection values.
- Persistent session and content databases are not removed by an implicit
  age-based retention pass. Temporary scripts, sentinels, fetch output, and
  process-owned SQLite files are still removed during bounded cleanup.
- Runtime dependencies are exact root pins and are installed only through the
  repository lockfile.

`ctx_execute` is process isolation, not an OS sandbox. Executed code can still
read and write paths available to the current user, inspect credentials stored
in files or command-line arguments, and access the public network. Review the
generated code or disable this extension when that authority is inappropriate.

## Provenance

- Upstream commit: `589d8214d56740a28b5f7bf63167743d586b0b40`
- Upstream tag/version: `v1.0.169` / `1.0.169`
- npm integrity: `sha512-94JIaFuLjF9SO2BsGTrbGtyT44K95+9OC8BdbaL/UT76xOkanJLfUR5CzmNw+GELXZQqH4nBrKg9wjBnSFkVnQ==`
- License: Elastic License 2.0; see `LICENSE`

The published `server.bundle.mjs` was not byte-reproducible from the tagged
source, so it is not used. The committed server bundle was rebuilt from the
pinned commit and its `bun.lock`; the Pi adapter was bundled separately from
the same patched source. Artifact hashes are recorded in `package.json`.
