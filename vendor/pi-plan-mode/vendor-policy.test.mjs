import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const VENDOR_ROOT = new URL("./", import.meta.url);

function sha256(relativePath) {
  return createHash("sha256")
    .update(readFileSync(new URL(relativePath, VENDOR_ROOT)))
    .digest("hex");
}

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, VENDOR_ROOT), "utf8");
}

function pinnedHashes() {
  const pinned = new Map();
  for (const line of readSource("SOURCE.sha256").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [hash, ...nameParts] = trimmed.split(/\s+/);
    if (hash && nameParts.length > 0) {
      pinned.set(nameParts.join(" "), hash);
    }
  }
  return pinned;
}

test("SOURCE.sha256 pins unpatched files exactly; index.ts carries only the documented patch", () => {
  const pinned = pinnedHashes();
  assert.ok(pinned.has("utils.ts"), "SOURCE.sha256 lists utils.ts");
  assert.ok(pinned.has("README.md"), "SOURCE.sha256 lists README.md");
  assert.ok(pinned.has("index.ts"), "SOURCE.sha256 lists index.ts");

  // Unpatched files must be byte-identical to upstream.
  assert.equal(sha256("utils.ts"), pinned.get("utils.ts"));
  assert.equal(sha256("README.md"), pinned.get("README.md"));

  // index.ts is patched, so it must differ from the pinned upstream hash…
  assert.notEqual(sha256("index.ts"), pinned.get("index.ts"));
  // …and the only allowed divergence is the documented questionnaire patch.
  const source = readSource("index.ts");
  assert.ok(
    source.includes(
      'const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls"]',
    ),
    "active plan-mode tool set no longer names the nonexistent questionnaire tool",
  );
  assert.ok(
    !/Ask clarifying questions using the questionnaire tool/.test(source),
    "plan-mode prompt no longer references a tool that is not in the runtime",
  );
  assert.match(source, /ask_user_question/);
  assert.match(source, /SOURCE-PATCHES\.md/);
});

test("extension surface: commands, flag, and shortcut stay within reviewed bounds", () => {
  const source = readSource("index.ts");
  assert.match(source, /registerCommand\("plan"/);
  assert.match(source, /registerCommand\("todos"/);
  assert.match(source, /registerFlag\("plan"/);
  // Toggle is Ctrl+Alt+P. Ctrl+P (model cycle) is intentionally left alone and
  // Tab stays the autocomplete trigger.
  assert.match(source, /registerShortcut\(Key\.ctrlAlt\("p"\)/);
  assert.doesNotMatch(source, /registerShortcut\([^)]*ctrl\+p[^)]*\)/);
  assert.doesNotMatch(source, /registerShortcut\([^)]*"tab"[^)]*\)/);
  // Plan mode must disable the write tools.
  assert.match(source, /PLAN_MODE_DISABLED_TOOLS = new Set<string>\(\["edit", "write"\]\)/);
});

test("source has no install hooks, dependency installs, or network imports", () => {
  const files = ["index.ts", "utils.ts"];
  for (const file of files) {
    const source = readSource(file);
    assert.doesNotMatch(source, /(child_process|node:child_process)\b/);
    assert.doesNotMatch(source, /fetch\s*\(/);
    assert.doesNotMatch(source, /new\s+WebSocket/);
    assert.doesNotMatch(source, /\bimport\s+.*\bfrom\s+["'](https?:|node:http|node:https)/);
    assert.doesNotMatch(source, /\beval\s*\(/);
    assert.doesNotMatch(source, /new\s+Function\b/);
    assert.doesNotMatch(source, /exec\s*\(/);
  }
});

test("no package manifest or install script ships in this vendor directory", () => {
  try {
    const pkg = JSON.parse(readSource("package.json"));
    assert.fail(`unexpected package.json: ${JSON.stringify(pkg)}`);
  } catch (error) {
    assert.ok(
      error instanceof Error && error.code === "ENOENT",
      "vendor directory must not ship a package.json with install hooks",
    );
  }
});

test("bash allowlist blocks destructive primitives regardless of flags", () => {
  const source = readSource("utils.ts");
  // The DESTRUCTIVE_PATTERNS regex literals are matched as literal source text
  // (`\b` in the pattern text is a backslash plus 'b', not a regex boundary).
  // They must cover file mutation, privilege escalation, process/system
  // control, package managers, and git writes.
  for (const word of [
    "rm",
    "rmdir",
    "mv",
    "cp",
    "mkdir",
    "touch",
    "chmod",
    "chown",
    "chgrp",
    "ln",
    "tee",
    "truncate",
    "dd",
    "shred",
    "sudo",
    "su",
    "kill",
    "pkill",
    "killall",
    "reboot",
    "shutdown",
  ]) {
    assert.ok(
      source.includes(`\\b${word}\\b`),
      `expected destructive pattern for ${word}`,
    );
  }
  assert.ok(source.includes("npm\\s+(install|uninstall|update|ci|link|publish)"));
  assert.ok(source.includes("git\\s+(add|commit|push|pull|merge|rebase|reset|checkout"));
});
