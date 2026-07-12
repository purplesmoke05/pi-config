import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import copilotInstructionsExtension from "./index.ts";

type EventHandler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
type MessageRenderer = (
	message: Record<string, unknown>,
	options: { expanded: boolean },
	theme: { fg: (color: string, text: string) => string; bg: (color: string, text: string) => string },
) => { render: (width: number) => string[] } | undefined;

const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createProject(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-copilot-instructions-"));
	temporaryRoots.push(root);
	mkdirSync(join(root, ".git"));
	mkdirSync(join(root, ".github", "instructions"), { recursive: true });
	return root;
}

function writeProjectFile(root: string, relativePath: string, content: string): void {
	const path = join(root, relativePath);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function instructionFile(applyTo: string, body: string): string {
	return `---\napplyTo: ${applyTo}\n---\n${body}\n`;
}

function sessionEntry(instructionPaths: string[]) {
	return {
		type: "custom_message",
		id: "entry",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		customType: "github-copilot-path-instructions",
		content: "previously activated",
		display: false,
		details: { instructionPaths },
	};
}

function compactionEntry(firstKeptEntryId: string) {
	return {
		type: "compaction",
		id: "compaction",
		parentId: "kept",
		timestamp: new Date(1).toISOString(),
		summary: "summary",
		firstKeptEntryId,
		tokensBefore: 1_000,
	};
}

function createHarness(root: string, initialBranch: Array<Record<string, unknown>> = []) {
	const handlers = new Map<string, EventHandler[]>();
	const sentMessages: Array<{
		message: Record<string, unknown>;
		options: Record<string, unknown> | undefined;
	}> = [];
	const renderers = new Map<string, MessageRenderer>();
	let branch = initialBranch;
	const pi = {
		on(event: string, handler: EventHandler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>) {
			sentMessages.push({ message, options });
		},
		registerMessageRenderer(customType: string, renderer: MessageRenderer) {
			renderers.set(customType, renderer);
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: root,
		sessionManager: { getBranch: () => branch },
	} as unknown as ExtensionContext;

	copilotInstructionsExtension(pi);
	const emit = async (type: string, event: Record<string, unknown>): Promise<unknown[]> => {
		const results: unknown[] = [];
		for (const handler of handlers.get(type) ?? []) results.push(await handler(event, ctx));
		return results;
	};
	const start = () => emit("session_start", { type: "session_start", reason: "startup" });
	const beforeAgentStart = async (prompt: string, systemPrompt = "base system") => {
		const [result] = await emit("before_agent_start", {
			type: "before_agent_start",
			prompt,
			systemPrompt,
			systemPromptOptions: {},
		});
		return (result ?? {}) as {
			message?: { content: string; details: { instructionPaths: string[] }; display: boolean };
			systemPrompt?: string;
		};
	};

	return {
		beforeAgentStart,
		emit,
		renderers,
		sentMessages,
		setBranch(nextBranch: Array<Record<string, unknown>>) {
			branch = nextBranch;
		},
		start,
	};
}

describe("GitHub Copilot instruction loading", () => {
	it("keeps repository-wide instructions fixed in the system prompt and activates matching @files as a user-context message", async () => {
		const root = createProject();
		writeProjectFile(root, ".github/copilot-instructions.md", "repository v1");
		writeProjectFile(
			root,
			".github/instructions/typescript.instructions.md",
			instructionFile('"**/*.{ts,tsx},docs/**/*.md"', "typescript rules"),
		);
		writeProjectFile(
			root,
			".github/instructions/python.instructions.md",
			instructionFile("\n  - \"**/*.py\"\n  - 'scripts/**/*.sh'", "python and scripts rules"),
		);
		writeProjectFile(root, ".github/instructions/missing.instructions.md", "---\ndescription: no applyTo\n---\nmissing rules");

		const harness = createHarness(root);
		await harness.start();
		writeProjectFile(root, ".github/copilot-instructions.md", "repository v2");
		const result = await harness.beforeAgentStart(
			`<file name="${root}/src/app.ts">\nsource\n</file>`,
		);

		assert.match(result.systemPrompt ?? "", /repository v1/);
		assert.doesNotMatch(result.systemPrompt ?? "", /repository v2|typescript rules|python and scripts rules/);
		assert.match(result.message?.content ?? "", /typescript rules/);
		assert.doesNotMatch(result.message?.content ?? "", /python and scripts rules|missing rules/);
		assert.deepEqual(result.message?.details.instructionPaths, [
			".github/instructions/typescript.instructions.md",
		]);
		assert.equal(result.message?.display, true);

		const renderer = harness.renderers.get("github-copilot-path-instructions");
		const rendered = renderer?.(
			{ ...result.message, role: "custom", customType: "github-copilot-path-instructions" },
			{ expanded: false },
			{ fg: (_color, text) => text, bg: (_color, text) => text },
		)?.render(120);
		assert.match(rendered?.join("\n") ?? "", /Copilot instructions activated · typescript\.instructions\.md/);
	});

	it("batches tool-path activation into one steering message and never resends it on ordinary turns", async () => {
		const root = createProject();
		writeProjectFile(
			root,
			".github/instructions/python.instructions.md",
			instructionFile('"**/*.py"', "python rules"),
		);
		const harness = createHarness(root);
		await harness.start();
		await harness.beforeAgentStart("inspect the project");

		await harness.emit("tool_call", {
			type: "tool_call",
			toolCallId: "read-1",
			toolName: "read",
			input: { path: "src/main.py" },
		});
		await harness.emit("tool_call", {
			type: "tool_call",
			toolCallId: "edit-1",
			toolName: "edit",
			input: { path: "src/other.py", edits: [] },
		});
		await harness.emit("turn_end", { type: "turn_end" });

		assert.equal(harness.sentMessages.length, 1);
		assert.match(String(harness.sentMessages[0].message.content), /python rules/);
		assert.equal(harness.sentMessages[0].message.display, true);
		assert.deepEqual(harness.sentMessages[0].options, { deliverAs: "steer" });

		await harness.emit("tool_call", {
			type: "tool_call",
			toolCallId: "write-1",
			toolName: "write",
			input: { path: "src/new.py", content: "" },
		});
		await harness.emit("turn_end", { type: "turn_end" });
		assert.equal(harness.sentMessages.length, 1);
	});

	it("restores activated instructions from the current branch and follows tree navigation", async () => {
		const root = createProject();
		const instructionPath = ".github/instructions/typescript.instructions.md";
		writeProjectFile(root, instructionPath, instructionFile('"**/*.ts"', "typescript rules"));
		const harness = createHarness(root, [sessionEntry([instructionPath])]);
		await harness.start();

		const resumed = await harness.beforeAgentStart(`<file name="${root}/src/app.ts">x</file>`);
		assert.equal(resumed.message, undefined);

		harness.setBranch([]);
		await harness.emit("session_tree", { type: "session_tree", newLeafId: "root", oldLeafId: "entry" });
		const navigated = await harness.beforeAgentStart(`<file name="${root}/src/app.ts">x</file>`);
		assert.match(navigated.message?.content ?? "", /typescript rules/);
	});

	it("reinjects active path instructions after compaction", async () => {
		const root = createProject();
		const instructionPath = ".github/instructions/typescript.instructions.md";
		writeProjectFile(root, instructionPath, instructionFile('"**/*.ts"', "typescript rules"));
		const activation = sessionEntry([instructionPath]);
		const kept = {
			type: "message",
			id: "kept",
			parentId: "entry",
			timestamp: new Date(1).toISOString(),
			message: { role: "user", content: "recent" },
		};
		const compaction = compactionEntry("kept");
		const harness = createHarness(root, [activation, kept, compaction]);
		await harness.start();

		await harness.emit("session_compact", { type: "session_compact", compactionEntry: compaction });
		assert.equal(harness.sentMessages.length, 1);
		assert.match(String(harness.sentMessages[0].message.content), /typescript rules/);
		assert.equal(harness.sentMessages[0].message.display, false);
	});

	it("does not duplicate an activation message retained by compaction", async () => {
		const root = createProject();
		const instructionPath = ".github/instructions/typescript.instructions.md";
		writeProjectFile(root, instructionPath, instructionFile('"**/*.ts"', "typescript rules"));
		const activation = sessionEntry([instructionPath]);
		const compaction = compactionEntry("entry");
		const harness = createHarness(root, [activation, compaction]);
		await harness.start();

		await harness.emit("session_compact", { type: "session_compact", compactionEntry: compaction });
		assert.equal(harness.sentMessages.length, 0);
	});

	it("does not activate instructions for paths outside the repository", async () => {
		const root = createProject();
		writeProjectFile(
			root,
			".github/instructions/typescript.instructions.md",
			instructionFile('"**/*.ts"', "typescript rules"),
		);
		const harness = createHarness(root);
		await harness.start();

		const result = await harness.beforeAgentStart('<file name="/tmp/outside.ts">x</file>');
		assert.equal(result.message, undefined);
	});
});
