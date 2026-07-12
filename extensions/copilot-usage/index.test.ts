import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import copilotUsageExtension from "./index.ts";

type EventHandler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

function createHarness(
	initialBranch: Array<Record<string, unknown>> = [],
	provider = "github-copilot",
) {
	const handlers = new Map<string, EventHandler[]>();
	const widgets = new Map<string, string[] | undefined>();
	const widgetWrites: Array<{ key: string; value: string[] | undefined }> = [];
	const statuses = new Map<string, string | undefined>();
	const branch = [...initialBranch];
	const systemPrompt = [
		'<project_instructions path="/work/project/not-native.md">fake custom markup</project_instructions>',
		'<project_instructions path="/work/project/AGENTS.md">',
		"agent instructions",
		"</project_instructions>",
		"<github_copilot_instructions>",
		'<instruction path=".github/copilot-instructions.md" kind="repository-wide">',
		"repository instructions",
		"</instruction>",
		"</github_copilot_instructions>",
	].join("\n");

	const pi = {
		on(event: string, handler: EventHandler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand() {},
		getActiveTools: () => [],
		getAllTools: () => [],
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: "/work/project",
		model: { provider, id: "gpt-5.6-luna" },
		sessionManager: { getBranch: () => branch },
		getSystemPrompt: () => systemPrompt,
		getContextUsage: () => ({ tokens: 0, contextWindow: 200_000, percent: 0 }),
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
			setWidget: (key: string, value: string[] | undefined) => {
				widgets.set(key, value);
				widgetWrites.push({ key, value });
			},
		},
	} as unknown as ExtensionContext;

	copilotUsageExtension(pi);
	const emit = (type: string, event: Record<string, unknown>): void => {
		for (const handler of handlers.get(type) ?? []) handler(event, ctx);
	};
	emit("session_start", { type: "session_start" });
	return { emit, statuses, systemPrompt, widgets, widgetWrites };
}

function providerPayload(harness: ReturnType<typeof createHarness>) {
	return {
		instructions: harness.systemPrompt,
		input: [],
		tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
	};
}

function showFirstRequestContext(harness: ReturnType<typeof createHarness>): void {
	const prompt = '<file name="/work/project/src/input.ts">\ncontents\n</file>';
	harness.emit("before_agent_start", {
		type: "before_agent_start",
		prompt,
		systemPrompt: "base prompt before later extensions",
		systemPromptOptions: {
			contextFiles: [{ path: "/work/project/AGENTS.md", content: "agent instructions" }],
		},
	});
	harness.emit("message_start", {
		type: "message_start",
		message: {
			role: "user",
			content: prompt,
		},
	});
	harness.emit("before_provider_request", {
		type: "before_provider_request",
		payload: providerPayload(harness),
	});
}

function showFirstRequestContextWithPathInstruction(harness: ReturnType<typeof createHarness>): void {
	const prompt = '<file name="/work/project/src/input.ts">\ncontents\n</file>';
	harness.emit("before_agent_start", {
		type: "before_agent_start",
		prompt,
		systemPrompt: "base prompt before later extensions",
		systemPromptOptions: {
			contextFiles: [{ path: "/work/project/AGENTS.md", content: "agent instructions" }],
		},
	});
	harness.emit("message_start", {
		type: "message_start",
		message: { role: "user", content: prompt },
	});
	harness.emit("message_start", {
		type: "message_start",
		message: {
			role: "custom",
			customType: "github-copilot-path-instructions",
			content:
				"<github_copilot_instructions>\n" +
				'<instruction path=".github/instructions/typescript.instructions.md" kind="path-specific">\n' +
				"typescript rules\n</instruction>\n</github_copilot_instructions>",
			display: true,
		},
	});
	harness.emit("before_provider_request", {
		type: "before_provider_request",
		payload: providerPayload(harness),
	});
}

describe("Copilot usage extension UI lifecycle", () => {
	it("does not show Copilot UI for another provider", () => {
		const harness = createHarness([], "openai");
		showFirstRequestContext(harness);

		assert.equal(harness.widgets.get("copilot-initial-context"), undefined);
		assert.equal(harness.statuses.get("copilot-usage"), undefined);
	});

	it("uses the final system prompt, shows tagged files once, and clears them on the next regular turn", () => {
		const harness = createHarness();
		showFirstRequestContext(harness);

		const widget = harness.widgets.get("copilot-initial-context") ?? [];
		assert.equal(widget[0], "Copilot first request · local token estimates · 3 files");
		assert.match(widget[1], /^request≈\d+ · system≈\d+ · tools≈[1-9]\d* · rest≈\d+ tok$/);
		assert.match(widget[2], /^system: base\/other≈\d+ · auto≈\d+ · Copilot≈\d+ · skills≈0 tok$/);
		assert.ok(widget.includes("automatic context:"));
		assert.ok(widget.some((line) => /^  AGENTS\.md ≈\d+ tok$/.test(line)));
		assert.ok(widget.some((line) => /^  \.github\/copilot-instructions\.md ≈\d+ tok$/.test(line)));
		assert.ok(widget.includes("prompt file tags:"));
		assert.ok(widget.some((line) => /^  src\/input\.ts ≈\d+ tok$/.test(line)));
		assert.match(harness.statuses.get("copilot-usage") ?? "", /Copilot sending≈/);
		assert.match(harness.statuses.get("copilot-usage") ?? "", /branch ≈0 cr, 0 in\/0 out tok/);

		const initialWidgetWrites = harness.widgetWrites.filter(
			(write) => write.key === "copilot-initial-context" && write.value !== undefined,
		).length;
		harness.emit("before_provider_request", {
			type: "before_provider_request",
			payload: providerPayload(harness),
		});
		assert.equal(
			harness.widgetWrites.filter(
				(write) => write.key === "copilot-initial-context" && write.value !== undefined,
			).length,
			initialWidgetWrites,
		);

		harness.emit("agent_end", { type: "agent_end", messages: [] });
		assert.notEqual(harness.widgets.get("copilot-initial-context"), undefined);

		harness.emit("before_agent_start", {
			type: "before_agent_start",
			prompt: "second turn",
			systemPrompt: harness.systemPrompt,
			systemPromptOptions: { contextFiles: [] },
		});
		assert.equal(harness.widgets.get("copilot-initial-context"), undefined);
	});

	it("clears first-request context when a queued user message starts", () => {
		const harness = createHarness();
		showFirstRequestContext(harness);

		harness.emit("message_start", {
			type: "message_start",
			message: {
				role: "user",
				content: [
					{ type: "text", text: "queued follow-up" },
					{ type: "image", data: "omitted", mimeType: "image/png" },
				],
			},
		});
		assert.equal(harness.widgets.get("copilot-initial-context"), undefined);
	});

	it("lists path-specific instruction files injected as custom user context", () => {
		const harness = createHarness();
		showFirstRequestContextWithPathInstruction(harness);

		const widget = harness.widgets.get("copilot-initial-context") ?? [];
		assert.equal(widget[0], "Copilot first request · local token estimates · 4 files");
		assert.ok(
			widget.some((line) =>
				/^  \.github\/instructions\/typescript\.instructions\.md ≈\d+ tok$/.test(line),
			),
		);
	});

	it("suppresses the widget when resuming a branch that already has an assistant response", () => {
		const harness = createHarness([
			{ type: "message", message: { role: "assistant", provider: "github-copilot" } },
		]);
		showFirstRequestContext(harness);

		assert.equal(harness.widgets.get("copilot-initial-context"), undefined);
		assert.equal(
			harness.widgetWrites.filter(
				(write) => write.key === "copilot-initial-context" && write.value !== undefined,
			).length,
			0,
		);
	});

	it("clears stale first-request context when navigating the session tree", () => {
		const harness = createHarness();
		showFirstRequestContext(harness);

		harness.emit("session_tree", { type: "session_tree", newLeafId: "other", oldLeafId: "first" });
		assert.equal(harness.widgets.get("copilot-initial-context"), undefined);
	});
});
