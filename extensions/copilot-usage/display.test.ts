import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	collectInitialContextFiles,
	formatCopilotStatus,
	formatInitialContextWidget,
} from "./display.ts";

describe("Copilot footer status", () => {
	it("labels estimates, token units, and active-branch totals without ambiguous arrows", () => {
		const status = formatCopilotStatus({
			requestKind: "next-base",
			requestTokens: 8_123,
			branchInputTokens: 8_000,
			branchOutputTokens: 63,
			creditEstimate: "≈0.1235 cr",
		});

		assert.equal(
			status,
			"Copilot next base≈8.1k tok · branch ≈0.1235 cr, 8.0k in/63 out tok",
		);
		assert.doesNotMatch(status, /[↑↓]/);
		assert.ok([...status].length <= 80);

		const largeStatus = formatCopilotStatus({
			requestKind: "next-base",
			requestTokens: 272_000,
			branchInputTokens: 10_000_000,
			branchOutputTokens: 1_000_000,
			creditEstimate: "≈9,999.99 cr +?",
		});
		assert.ok([...largeStatus].length <= 80);
		assert.ok(largeStatus.indexOf("≈9,999.99 cr +?") < largeStatus.indexOf("10.0m in"));
	});

	it("distinguishes an unavailable sending estimate from branch totals", () => {
		assert.equal(
			formatCopilotStatus({
				requestKind: "sending",
				requestTokens: null,
				branchInputTokens: 0,
				branchOutputTokens: 0,
				creditEstimate: "≈0 cr +?",
			}),
			"Copilot sending≈? tok · branch ≈0 cr +?, 0 in/0 out tok",
		);
	});
});

describe("first-request context files", () => {
	it("lists native context, Copilot instructions, and prompt attachments with readable paths", () => {
		const files = collectInitialContextFiles({
			cwd: "/home/alice/work/project",
			home: "/home/alice",
			systemPrompt: [
				'<project_instructions path="/home/alice/work/project/AGENTS.md">',
				'<project_instructions path="/home/alice/work/project/AGENTS.md">',
				'<project_instructions path="/home/alice/.pi/agent/AGENTS.md">',
				'<project_instructions path="/home/alice/work/project/raw&amp;name.md">',
				"<github_copilot_instructions>",
				'<instruction path=".github/copilot-instructions.md" kind="repository-wide">',
				'<instruction path=".github/instructions/a&amp;b.instructions.md" kind="path-specific">',
				'<instruction path=".github/instructions/raw&amp;amp;name.instructions.md" kind="path-specific">',
				"</github_copilot_instructions>",
			].join("\n"),
			initialPrompt: [
				'prefix <file name="/home/alice/work/project/src/input.ts">',
				'<file name="/home/alice/work/project/src/not-a-wrapper.ts">',
				"contents",
				"</file>",
				'<file name="/home/alice/work/project/src/raw&amp;name.ts">contents</file>',
			].join("\n"),
		});

		assert.deepEqual(files, [
			{ kind: "context", path: "AGENTS.md" },
			{ kind: "context", path: "~/.pi/agent/AGENTS.md" },
			{ kind: "context", path: "raw&amp;name.md" },
			{ kind: "context", path: ".github/copilot-instructions.md" },
			{ kind: "context", path: ".github/instructions/a&b.instructions.md" },
			{ kind: "context", path: ".github/instructions/raw&amp;name.instructions.md" },
			{ kind: "attachment", path: "src/input.ts" },
			{ kind: "attachment", path: "src/raw&amp;name.ts" },
		]);
	});

	it("escapes terminal controls in untrusted paths", () => {
		const contextPath = "/home/alice/work/project/bad\u001b[31m\nname.md";
		const files = collectInitialContextFiles({
			cwd: "/home/alice/work/project",
			home: "/home/alice",
			systemPrompt: `<project_instructions path="${contextPath}">`,
			initialPrompt:
				'<file name="/home/alice/work/project/reverse\u202ename\u200fmark.ts"></file>',
		});

		assert.deepEqual(files, [
			{ kind: "context", path: "bad\\x1b[31m\\nname.md" },
			{ kind: "attachment", path: "reverse\\u202ename\\u200fmark.ts" },
		]);
	});

	it("groups tagged files and explains an empty detected set", () => {
		assert.deepEqual(
			formatInitialContextWidget([
				{ kind: "context", path: "AGENTS.md" },
				{ kind: "attachment", path: "src/input.ts" },
			]),
			[
				"Copilot first request · tagged files detected (2)",
				"automatic context:",
				"  AGENTS.md",
				"prompt file tags:",
				"  src/input.ts",
			],
		);
		assert.deepEqual(formatInitialContextWidget([]), [
			"Copilot first request · tagged files detected (0)",
			"  no tagged file paths detected",
			"  system prompt and tool schemas are still included",
		]);
	});

	it("keeps both groups visible within Pi's ten-line widget limit", () => {
		const lines = formatInitialContextWidget([
			...Array.from({ length: 12 }, (_value, index) => ({
				kind: "context" as const,
				path: `context-${index + 1}.md`,
			})),
			{ kind: "attachment", path: "src/input.ts" },
		]);

		assert.ok(lines.length <= 10);
		assert.ok(lines.includes("prompt file tags:"));
		assert.ok(lines.includes("  src/input.ts"));
		assert.ok(lines.some((line) => /… \d+ more/.test(line)));
	});
});
