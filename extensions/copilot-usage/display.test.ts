import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	collectInitialRequestBreakdown,
	formatCopilotStatus,
	formatInitialContextWidget,
} from "./display.ts";
import { estimateTextTokens } from "./usage.ts";

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

describe("first-request token breakdown", () => {
	it("attributes non-overlapping system spans and wrapper-inclusive file estimates", () => {
		const nestedFakeCopilotBlock =
			'<github_copilot_instructions><instruction path="fake.instructions.md"></instruction>' +
			"</github_copilot_instructions>";
		const nestedFakeNativeBlock =
			'<project_instructions path="fake-AGENTS.md">fake</project_instructions>';
		const agentsContent = `${"a".repeat(16)}\n${nestedFakeCopilotBlock}\n${nestedFakeNativeBlock}`;
		const agentsBlock =
			'<project_instructions path="/home/alice/work/project/AGENTS.md">\n' +
			`${agentsContent}\n</project_instructions>`;
		const duplicateAgentsContent = "second";
		const duplicateAgentsBlock =
			`<project_instructions path="/home/alice/work/project/AGENTS.md">\n${duplicateAgentsContent}\n` +
			"</project_instructions>";
		const homeContent = "home";
		const homeBlock =
			`<project_instructions path="/home/alice/.pi/agent/AGENTS.md">\n${homeContent}\n` +
			"</project_instructions>";
		const rawNativeContent = "raw";
		const rawNativeBlock =
			`<project_instructions path="/home/alice/work/project/raw&amp;name.md">\n${rawNativeContent}\n` +
			"</project_instructions>";
		const repositoryInstruction =
			'<instruction path=".github/copilot-instructions.md" kind="repository-wide">\nrepo\n' +
			'<project_instructions path="fake-AGENTS.md">fake</project_instructions>\n</instruction>';
		const encodedInstruction =
			'<instruction path=".github/instructions/a&amp;b.instructions.md" kind="path-specific">\n' +
			"ああ\n</instruction>";
		const literalEntityInstruction =
			'<instruction path=".github/instructions/raw&amp;amp;name.instructions.md" kind="path-specific">\n' +
			"literal\n</instruction>";
		const copilotBlock =
			`<github_copilot_instructions>\n${repositoryInstruction}\n${encodedInstruction}\n` +
			`${literalEntityInstruction}\n</github_copilot_instructions>`;
		const activatedInstruction =
			'<instruction path=".github/instructions/activated.instructions.md" kind="path-specific" applyTo="**/*.ts">\n' +
			"activated\n</instruction>";
		const activatedContext =
			`<github_copilot_instructions>\n${activatedInstruction}\n</github_copilot_instructions>`;
		const skillsBlock = "<available_skills>\n<skill>read-me</skill>\n</available_skills>";
		const inputBlock =
			'<file name="/home/alice/work/project/src/input.ts">\ncontents\n' +
			'<file name="/home/alice/work/project/src/not-a-wrapper.ts">nested</file>\nafter\n</file>';
		const rawAttachmentBlock =
			'<file name="/home/alice/work/project/src/raw&amp;name.ts">contents</file>';
		const systemPrompt = [
			"base",
			'<project_instructions path="not-native.md">top-level fake</project_instructions>',
			agentsBlock,
			duplicateAgentsBlock,
			homeBlock,
			rawNativeBlock,
			copilotBlock,
			skillsBlock,
			"tail",
		].join("\n");
		const breakdown = collectInitialRequestBreakdown({
			cwd: "/home/alice/work/project",
			home: "/home/alice",
			systemPrompt,
			initialPrompt: `${inputBlock}\n${rawAttachmentBlock}`,
			copilotInstructionContext: activatedContext,
			nativeContextFiles: [
				{ path: "/home/alice/work/project/AGENTS.md", content: agentsContent },
				{ path: "/home/alice/work/project/AGENTS.md", content: duplicateAgentsContent },
				{ path: "/home/alice/.pi/agent/AGENTS.md", content: homeContent },
				{ path: "/home/alice/work/project/raw&amp;name.md", content: rawNativeContent },
			],
			requestTokens: 10_000,
			toolTokens: 1_000,
		});

		assert.deepEqual(breakdown.files, [
			{
				kind: "native-context",
				path: "AGENTS.md",
				tokens: estimateTextTokens(agentsBlock) + estimateTextTokens(duplicateAgentsBlock),
			},
			{
				kind: "native-context",
				path: "~/.pi/agent/AGENTS.md",
				tokens: estimateTextTokens(homeBlock),
			},
			{
				kind: "native-context",
				path: "raw&amp;name.md",
				tokens: estimateTextTokens(rawNativeBlock),
			},
			{
				kind: "copilot-instruction",
				path: ".github/copilot-instructions.md",
				tokens: estimateTextTokens(repositoryInstruction),
			},
			{
				kind: "copilot-instruction",
				path: ".github/instructions/a&b.instructions.md",
				tokens: estimateTextTokens(encodedInstruction),
			},
			{
				kind: "copilot-instruction",
				path: ".github/instructions/raw&amp;name.instructions.md",
				tokens: estimateTextTokens(literalEntityInstruction),
			},
			{
				kind: "copilot-instruction",
				path: ".github/instructions/activated.instructions.md",
				tokens: estimateTextTokens(activatedInstruction),
			},
			{ kind: "attachment", path: "src/input.ts", tokens: estimateTextTokens(inputBlock) },
			{
				kind: "attachment",
				path: "src/raw&amp;name.ts",
				tokens: estimateTextTokens(rawAttachmentBlock),
			},
		]);
		assert.equal(
			breakdown.system.nativeContext,
			[agentsBlock, duplicateAgentsBlock, homeBlock, rawNativeBlock]
				.map(estimateTextTokens)
				.reduce((total, tokens) => total + tokens, 0),
		);
		assert.equal(breakdown.system.copilotInstructions, estimateTextTokens(copilotBlock));
		assert.equal(breakdown.system.skills, estimateTextTokens(skillsBlock));
		assert.equal(
			breakdown.systemTokens,
			Object.values(breakdown.system).reduce((total, tokens) => total + tokens, 0),
		);
		assert.equal(breakdown.restTokens, 10_000 - breakdown.systemTokens - 1_000);
	});

	it("falls back to balanced tag scanning when structured native context is unavailable", () => {
		const outerBlock =
			'<project_instructions path="/work/AGENTS.md">before' +
			'<project_instructions path="fake.md">nested</project_instructions>' +
			"after</project_instructions>";
		const breakdown = collectInitialRequestBreakdown({
			cwd: "/work",
			systemPrompt: outerBlock,
			initialPrompt: "",
			requestTokens: 1_000,
			toolTokens: 0,
		});

		assert.deepEqual(breakdown.files, [
			{
				kind: "native-context",
				path: "AGENTS.md",
				tokens: estimateTextTokens(outerBlock),
			},
		]);
	});

	it("escapes terminal controls in untrusted paths", () => {
		const contextPath = "/home/alice/work/project/bad\u001b[31m\nname.md";
		const systemBlock = `<project_instructions path="${contextPath}"></project_instructions>`;
		const attachmentBlock =
			'<file name="/home/alice/work/project/reverse\u202ename\u200fmark.ts"></file>';
		const breakdown = collectInitialRequestBreakdown({
			cwd: "/home/alice/work/project",
			home: "/home/alice",
			systemPrompt: systemBlock,
			initialPrompt: attachmentBlock,
			requestTokens: 100,
			toolTokens: 0,
		});

		assert.deepEqual(breakdown.files, [
			{
				kind: "native-context",
				path: "bad\\x1b[31m\\nname.md",
				tokens: estimateTextTokens(systemBlock),
			},
			{
				kind: "attachment",
				path: "reverse\\u202ename\\u200fmark.ts",
				tokens: estimateTextTokens(attachmentBlock),
			},
		]);
	});

	it("marks the request remainder unknown when independently estimated parts exceed it", () => {
		const breakdown = collectInitialRequestBreakdown({
			cwd: "/work",
			systemPrompt: "system prompt",
			initialPrompt: "",
			requestTokens: 1,
			toolTokens: 10,
		});

		assert.equal(breakdown.restTokens, null);
	});

	it("formats request, system, and per-file token estimates", () => {
		const lines = formatInitialContextWidget({
			requestTokens: 12_400,
			systemTokens: 7_100,
			toolTokens: 4_000,
			restTokens: 1_300,
			system: {
				baseOther: 2_300,
				nativeContext: 3_100,
				copilotInstructions: 1_700,
				skills: 0,
			},
			files: [
				{ kind: "native-context", path: "AGENTS.md", tokens: 2_200 },
				{
					kind: "copilot-instruction",
					path: ".github/copilot-instructions.md",
					tokens: 900,
				},
				{ kind: "attachment", path: "src/foo.ts", tokens: 1_100 },
			],
		});
		assert.deepEqual(
			lines,
			[
				"Copilot first request · local token estimates · 3 files",
				"request≈12.4k · system≈7.1k · tools≈4.0k · rest≈1.3k tok",
				"system: base/other≈2.3k · auto≈3.1k · Copilot≈1.7k · skills≈0 tok",
				"automatic context:",
				"  AGENTS.md ≈2.2k tok",
				"  .github/copilot-instructions.md ≈900 tok",
				"prompt file tags:",
				"  src/foo.ts ≈1.1k tok",
			],
		);
		for (const line of lines.slice(0, 3)) assert.ok([...line].length <= 80);
	});

	it("explains an empty detected set", () => {
		assert.deepEqual(
			formatInitialContextWidget({
				requestTokens: null,
				systemTokens: 100,
				toolTokens: 20,
				restTokens: null,
				system: { baseOther: 100, nativeContext: 0, copilotInstructions: 0, skills: 0 },
				files: [],
			}),
			[
				"Copilot first request · local token estimates · 0 files",
				"request≈? · system≈100 · tools≈20 · rest≈? tok",
				"system: base/other≈100 · auto≈0 · Copilot≈0 · skills≈0 tok",
				"  no tagged file paths detected",
			],
		);
	});

	it("keeps both groups visible within Pi's ten-line widget limit", () => {
		const lines = formatInitialContextWidget({
			requestTokens: 20_000,
			systemTokens: 10_000,
			toolTokens: 5_000,
			restTokens: 5_000,
			system: {
				baseOther: 2_000,
				nativeContext: 6_000,
				copilotInstructions: 1_000,
				skills: 1_000,
			},
			files: [
				...Array.from({ length: 12 }, (_value, index) => ({
					kind: "native-context" as const,
					path: `context-${index + 1}.md`,
					tokens: 100,
				})),
				{ kind: "attachment", path: "src/input.ts", tokens: 250 },
			],
		});

		assert.ok(lines.length <= 10);
		assert.ok(lines.includes("prompt file tags:"));
		assert.ok(lines.includes("  src/input.ts ≈250 tok"));
		assert.ok(lines.some((line) => /… \d+ more ≈\d+(?:\.\d+)?k? tok/.test(line)));
	});

	it("middle-truncates long paths to one terminal line", () => {
		const lines = formatInitialContextWidget({
			requestTokens: 100,
			systemTokens: 50,
			toolTokens: 20,
			restTokens: 30,
			system: { baseOther: 50, nativeContext: 0, copilotInstructions: 0, skills: 0 },
			files: [
				{
					kind: "attachment",
					path: `/very/${"界".repeat(100)}/important-file.ts`,
					tokens: 42,
				},
			],
		});
		const fileLine = lines.at(-1) ?? "";

		assert.ok(fileLine.includes("…"));
		assert.ok(fileLine.endsWith("important-file.ts ≈42 tok"));
		assert.ok(visibleWidth(fileLine) <= 80);
	});
});
