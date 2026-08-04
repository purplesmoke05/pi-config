import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const VENDOR_ROOT = new URL("./", import.meta.url);
const VENDOR_ROOT_PATH = fileURLToPath(VENDOR_ROOT);
const RUNTIME_ROOTS = ["extensions", "skills", "src"];
const SOURCE_ROOTS = ["docs", "extensions", "scripts", "skills", "src", "tests"];
const SOURCE_FILES = [
  "LICENSE",
  "UPSTREAM-CONTRIBUTING.md",
  "UPSTREAM-README.md",
  "UPSTREAM-package-lock.json",
  "biome.json",
  "tsconfig.json",
  "tsconfig.scripts.json",
  "vendor-policy.test.mjs",
];

function vendorPath(relativePath) {
  return join(VENDOR_ROOT_PATH, ...relativePath.split("/"));
}

function readText(relativePath) {
  return readFileSync(vendorPath(relativePath), "utf8");
}

function sha256(relativePath) {
  return createHash("sha256")
    .update(readFileSync(vendorPath(relativePath)))
    .digest("hex");
}

function listRegularFiles(relativeRoot) {
  const rootPath = vendorPath(relativeRoot);
  const files = [];

  function walk(directoryPath) {
    for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
      const entryPath = join(directoryPath, entry.name);
      const stat = lstatSync(entryPath);
      assert.equal(stat.isSymbolicLink(), false, `symlink is not vendored: ${entryPath}`);
      if (stat.isDirectory()) walk(entryPath);
      else if (stat.isFile()) files.push(relative(VENDOR_ROOT_PATH, entryPath).split(sep).join("/"));
      else assert.fail(`special file is not vendored: ${entryPath}`);
    }
  }

  walk(rootPath);
  return files.sort();
}

function parseHashManifest(relativePath) {
  const entries = new Map();
  for (const [index, line] of readText(relativePath).trimEnd().split("\n").entries()) {
    const match = line.match(/^([a-f0-9]{64}) {2}([^\r\n]+)$/);
    assert.ok(match, `${relativePath}:${index + 1}: invalid hash entry`);
    const [, hash, filePath] = match;
    assert.equal(filePath.startsWith("/") || filePath.split("/").includes(".."), false);
    assert.equal(entries.has(filePath), false, `${relativePath}: duplicate ${filePath}`);
    entries.set(filePath, hash);
  }
  return entries;
}

function verifyHashManifest(manifestPath, expectedFiles) {
  const entries = parseHashManifest(manifestPath);
  assert.deepEqual([...entries.keys()].sort(), expectedFiles);
  for (const [filePath, expectedHash] of entries) {
    assert.equal(sha256(filePath), expectedHash, `${filePath} hash mismatch`);
  }
}

function saveEnvironment(names) {
  return new Map(names.map((name) => [name, process.env[name]]));
}

function restoreEnvironment(saved) {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

test("provenance, exact dependencies, policy, and manifests are pinned", () => {
  const manifest = JSON.parse(readText("package.json"));
  assert.equal(manifest.private, true);
  assert.equal(manifest.main, undefined);
  assert.equal(manifest.types, undefined);
  assert.equal(manifest.exports, undefined);
  assert.equal(manifest.publishConfig, undefined);
  assert.equal(manifest.engines.node, ">=24.18.0");
  for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
    assert.equal(manifest.scripts?.[hook], undefined, `${hook} must not run during consumer installation`);
  }
  assert.equal(manifest.scripts.build, "tsc --noEmit");
  assert.deepEqual(manifest.dependencies, { acorn: "8.16.0", typebox: "1.2.8" });
  assert.deepEqual(manifest.pi, {
    extensions: ["extensions/workflow.ts"],
    skills: ["skills/workflow-authoring", "skills/workflow-patterns"],
  });
  assert.deepEqual(manifest["x-vendored-from"], {
    version: "3.5.0",
    tag: "v3.5.0",
    commit: "356ea76836d04bcd2e9cbc09b289d5f18f732c65",
    npmShasum: "668750d4053e5f446da810139000c916c623d472",
    npmIntegrity: "sha512-B/uq11yAxDECfEVL4D/bmO84+Hf/+RrdNEB2z6bnpzkh5yF2zTZiIhuHtZ/Dh2a7EO95xBrjeCPsm220NnFnXg==",
    npmTarballSha256: "b6c248aae5b09dc6d74cdb84367000da7e314cfa101c582a67b35f781cddb42c",
    npmProvenance: true,
    npmSignatureKeyId: "SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U",
  });
  assert.deepEqual(manifest["x-vendor-policy"], {
    vmSecuritySandbox: false,
    activeRuntimePackageJsonImport: false,
    customWorkflowApprovalRequired: true,
    nestedWorkflowExecution: false,
    headlessCustomWorkflowExecution: false,
    customWorkflowAutoResume: false,
    keywordTriggerDefaultEnabled: false,
    builtinWorkflowPrecedence: true,
    projectAgentsRequireHostTrust: true,
    sharedCheckoutWorktreeFallback: false,
    unknownToolsetFallback: false,
    projectLocalLegacyPersistence: false,
    deepResearchToolset: "web-only",
    publicHttpTransport: "../pi-smart-fetch/core/public-http.ts",
    stateDirectoryMode: "0700",
    stateFileMode: "0600",
  });

  const runtimeFiles = RUNTIME_ROOTS.flatMap(listRegularFiles).sort();
  const sourceFiles = [...SOURCE_ROOTS.flatMap(listRegularFiles), ...SOURCE_FILES].sort();
  verifyHashManifest("RUNTIME.sha256", runtimeFiles);
  verifyHashManifest("SOURCE.sha256", sourceFiles);

  const artifacts = manifest["x-vendor-artifacts"];
  assert.equal(sha256("RUNTIME.sha256"), artifacts.runtimeManifestSha256);
  assert.equal(sha256("SOURCE.sha256"), artifacts.sourceManifestSha256);
  assert.equal(sha256("UPSTREAM-package-lock.json"), artifacts.upstreamPackageLockSha256);
  assert.equal(sha256("README.md"), artifacts.readmeSha256);
  assert.equal(sha256("NOTICE"), artifacts.noticeSha256);
  assert.equal(sha256("SOURCE-PATCHES.md"), artifacts.sourcePatchesSha256);
  assert.equal(sha256("../pi-smart-fetch/core/constants.ts"), artifacts.publicHttpConstantsSha256);
  assert.equal(sha256("../pi-smart-fetch/core/types.ts"), artifacts.publicHttpTypesSha256);
  assert.equal(sha256("../pi-smart-fetch/core/safe-http.ts"), artifacts.publicHttpPolicySha256);
  assert.equal(sha256("../pi-smart-fetch/core/public-http.ts"), artifacts.publicHttpTransportSha256);
});

test("the source-only runtime keeps the reviewed web transport boundary", () => {
  assert.throws(() => lstatSync(vendorPath("dist")), { code: "ENOENT" });
  assert.throws(() => lstatSync(vendorPath("AGENTS.md")), { code: "ENOENT" });

  const extension = readText("extensions/workflow.ts");
  assert.doesNotMatch(readText("src/extension-reload.ts"), /\.\.\/package\.json/);
  assert.doesNotMatch(readText("src/workflow-capability-contract.ts"), /\.\.\/package\.json/);
  assert.match(extension, /from "\.\.\/\.\.\/pi-smart-fetch\/core\/safe-http\.ts"/);
  assert.match(extension, /from "\.\.\/\.\.\/pi-smart-fetch\/core\/public-http\.ts"/);
  assert.match(extension, /enforceCustomWorkflowApproval:\s*true/);
  for (const path of RUNTIME_ROOTS.flatMap(listRegularFiles).filter((path) => path.endsWith(".ts"))) {
    const source = readText(path);
    if (path === "extensions/workflow.ts") continue;
    assert.doesNotMatch(source, /pi-smart-fetch/, `${path} bypasses the composition root`);
    assert.doesNotMatch(source, /\bfetch\s*\(/, `${path} adds an unreviewed native fetch path`);
  }
});

test("Pi 0.80.10 loads the reviewed complete session surface", async () => {
  const saved = saveEnvironment(["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR"]);
  const temporaryHome = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-load-"));
  process.env.HOME = temporaryHome;
  process.env.USERPROFILE = temporaryHome;
  process.env.PI_CODING_AGENT_DIR = join(temporaryHome, ".pi", "agent");
  try {
    const extensionPath = vendorPath("extensions/workflow.ts");
    const loaded = await discoverAndLoadExtensions([extensionPath], VENDOR_ROOT_PATH, process.env.PI_CODING_AGENT_DIR);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const [extension] = loaded.extensions;
    let activeTools = [];
    loaded.runtime.getActiveTools = () => activeTools;
    loaded.runtime.setActiveTools = (next) => {
      activeTools = [...next];
    };
    loaded.runtime.getAllTools = () => [...extension.tools.keys()];
    const ctx = {
      ui: {
        notify() {},
        setWidget() {},
        setStatus() {},
      },
      mode: "print",
      hasUI: false,
      cwd: VENDOR_ROOT_PATH,
      model: undefined,
      modelRegistry: {},
      sessionManager: {
        getSessionId() {
          return "vendor-policy";
        },
      },
      isProjectTrusted() {
        return false;
      },
    };
    for (const handler of extension.handlers.get("session_start") ?? []) {
      await handler({ type: "session_start" }, ctx);
    }
    assert.deepEqual([...extension.tools.keys()].sort(), ["workflow", "workflow_control"]);
    assert.deepEqual([...extension.commands.keys()].sort(), [
      "adversarial-review",
      "code-review",
      "codebase-audit",
      "deep-research",
      "effort",
      "multi-perspective",
      "ultracode",
      "workflows",
      "workflows-models",
      "workflows-progress",
      "workflows-trigger",
    ]);
    assert.deepEqual(activeTools.sort(), ["workflow", "workflow_control"]);
    assert.deepEqual([...extension.handlers.keys()].sort(), ["input", "session_shutdown", "session_start", "turn_end"]);
    for (const handler of extension.handlers.get("session_shutdown") ?? []) {
      await handler({ reason: "exit" }, ctx);
    }
  } finally {
    restoreEnvironment(saved);
    rmSync(temporaryHome, { recursive: true, force: true });
  }
});
