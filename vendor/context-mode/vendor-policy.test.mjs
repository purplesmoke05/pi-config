import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const VENDOR_ROOT = new URL("./", import.meta.url);

function sha256(relativePath) {
  return createHash("sha256")
    .update(readFileSync(new URL(relativePath, VENDOR_ROOT)))
    .digest("hex");
}

async function removeTempRootAfterChildExit(path) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "ENOTEMPTY" && error?.code !== "EBUSY") throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

test("committed runtime matches the reviewed hashes and policy", async () => {
  const manifest = JSON.parse(readFileSync(new URL("package.json", VENDOR_ROOT), "utf8"));
  assert.equal(
    sha256("server.bundle.mjs"),
    manifest["x-vendor-artifacts"].serverBundleSha256,
  );
  assert.equal(
    sha256("build/adapters/pi/extension.js"),
    manifest["x-vendor-artifacts"].piExtensionBundleSha256,
  );

  const serverSource = readFileSync(new URL("source/server.ts", VENDOR_ROOT), "utf8");
  const extensionSource = readFileSync(
    new URL("source/adapters/pi/extension.ts", VENDOR_ROOT),
    "utf8",
  );
  assert.doesNotMatch(serverSource, /function fetchLatestVersion/);
  assert.doesNotMatch(serverSource, /cleanupStaleContentDBs\(/);
  assert.doesNotMatch(serverSource, /_store\.cleanupStaleSources\(/);
  assert.doesNotMatch(extensionSource, /cleanupOldSessions\(/);

  const tempRoot = mkdtempSync(join(tmpdir(), "context-mode-vendor-test-"));
  const projectDir = join(tempRoot, "project");
  mkdirSync(projectDir);

  const saved = new Map();
  for (const name of [
    "HOME",
    "PWD",
    "PI_PROJECT_DIR",
    "CONTEXT_MODE_DATA_DIR",
    "TEST_VENDOR_TOKEN",
  ]) {
    saved.set(name, process.env[name]);
  }

  const handlers = new Map();
  const tools = new Map();
  const pi = {
    on(name, handler) {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
  };

  try {
    process.env.HOME = tempRoot;
    process.env.PWD = projectDir;
    process.env.PI_PROJECT_DIR = projectDir;
    process.env.CONTEXT_MODE_DATA_DIR = tempRoot;
    process.env.TEST_VENDOR_TOKEN = "must-not-leak";

    const extension = await import("./build/adapters/pi/extension.js");
    extension.default(pi);
    assert.equal(tools.size, 0, "extension discovery must not spawn the MCP server");

    for (const handler of handlers.get("session_start") ?? []) {
      await handler({}, {
        sessionManager: {
          getSessionFile: () => join(tempRoot, "session.jsonl"),
        },
      });
    }
    for (const handler of handlers.get("before_agent_start") ?? []) {
      await handler({ prompt: "vendor smoke", systemPrompt: "" }, { hasUI: false });
    }

    assert.deepEqual([...tools.keys()].sort(), [
      "ctx_batch_execute",
      "ctx_doctor",
      "ctx_execute",
      "ctx_execute_file",
      "ctx_fetch_and_index",
      "ctx_index",
      "ctx_search",
      "ctx_stats",
    ]);

    const execution = await tools.get("ctx_execute").execute("vendor-smoke", {
      language: "shell",
      code: 'printf "%s" "${TEST_VENDOR_TOKEN:-unset}"',
    });
    const executionText = execution.content.map((part) => part.text).join("\n");
    assert.match(executionText, /unset/);
    assert.doesNotMatch(executionText, /must-not-leak/);

    await assert.rejects(
      tools.get("ctx_fetch_and_index").execute("vendor-ssrf", {
        url: "http://127.0.0.1/",
        force: true,
      }),
      /private IP|blocked/i,
    );
  } finally {
    for (const handler of handlers.get("session_shutdown") ?? []) {
      await handler();
    }
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await removeTempRootAfterChildExit(tempRoot);
  }
});
