import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
	COLLAPSE_KEY_OFF,
	DEFAULT_COLLAPSE_KEY,
	loadConfig,
	resolveCollapseKey,
	validateGuidanceFields,
} from "./config.ts";

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const testConfigHome = mkdtempSync(join(tmpdir(), "rpiv-ask-user-question-test-"));
process.env.XDG_CONFIG_HOME = testConfigHome;

after(() => {
	if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
	rmSync(testConfigHome, { recursive: true, force: true });
});

test("collapse key validation rejects malformed modifiers", () => {
	assert.equal(resolveCollapseKey({}), DEFAULT_COLLAPSE_KEY);
	assert.equal(resolveCollapseKey({ collapseKey: "  ALT+O  " }), "alt+o");
	assert.equal(resolveCollapseKey({ collapseKey: "off" }), COLLAPSE_KEY_OFF);
	assert.equal(resolveCollapseKey({ collapseKey: "ctr+]" }), DEFAULT_COLLAPSE_KEY);
	assert.equal(resolveCollapseKey({ collapseKey: "ctrl+ctrl+]" }), DEFAULT_COLLAPSE_KEY);
});

test("read-only local config subset loads the XDG config", () => {
	const directory = join(testConfigHome, "rpiv-ask-user-question");
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "config.json"),
		JSON.stringify({ collapseKey: "ctrl+pageup", guidance: { promptSnippet: "Ask deliberately" } }),
		"utf8",
	);

	assert.deepEqual(loadConfig(), {
		collapseKey: "ctrl+pageup",
		guidance: { promptSnippet: "Ask deliberately" },
	});
});

test("guidance validation strips malformed values and unrelated keys", () => {
	assert.deepEqual(
		validateGuidanceFields({
			promptSnippet: "Use the questionnaire",
			promptGuidelines: ["Group related questions"],
			unreviewed: true,
		}),
		{
			promptSnippet: "Use the questionnaire",
			promptGuidelines: ["Group related questions"],
		},
	);
	assert.deepEqual(validateGuidanceFields({ promptSnippet: "", promptGuidelines: [""] }), {});
});
