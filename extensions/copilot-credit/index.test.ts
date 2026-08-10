import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import copilotCreditExtension from "./index.ts";

type EventHandler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

function createHarness(provider = "github-copilot", execOutput = "{}") {
	const handlers = new Map<string, EventHandler[]>();
	const widgets = new Map<string, string[] | undefined>();
	const branch: unknown[] = [];

	const pi = {
		on(event: string, handler: EventHandler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand() {},
		exec: async () => ({ code: 0, stdout: execOutput, stderr: "" }),
	} as unknown as ExtensionAPI;
	const ctx = {
		model: { provider, id: "gpt-5.6-luna" },
		sessionManager: { getBranch: () => branch },
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setWidget: (key: string, value: string[] | undefined) => widgets.set(key, value),
			notify() {},
		},
	} as unknown as ExtensionContext;

	copilotCreditExtension(pi);
	const emit = (type: string, event: Record<string, unknown>): void => {
		for (const handler of handlers.get(type) ?? []) handler(event, ctx);
	};
	emit("session_start", { type: "session_start" });
	return { emit, widgets };
}

const QUOTA_JSON = JSON.stringify({
	login: "octocat",
	plan: "pro",
	quota_reset_date_utc: "2026-08-01T00:00:00.000Z",
	quota_snapshots: {
		premium_interactions: {
			entitlement: 300,
			remaining: 93,
			percent_remaining: 31,
			unlimited: false,
			overage_count: 0,
		},
	},
});

describe("copilot-credit widget", () => {
	it("shows the Copilot CLI-style credit line once the quota resolves", async () => {
		const harness = createHarness("github-copilot", QUOTA_JSON);
		await new Promise((resolve) => setImmediate(resolve));
		const lines = harness.widgets.get("copilot-credit") ?? [];
		assert.ok(lines.some((line) => line.includes("Plan: 207/300 (69% used)")));
		assert.ok(lines.some((line) => line.includes("Session: 0.00 AIC used")));
	});

	it("shows only the session meter when the quota endpoint reports no quota", async () => {
		const harness = createHarness("github-copilot", "{}");
		await new Promise((resolve) => setImmediate(resolve));
		const lines = harness.widgets.get("copilot-credit") ?? [];
		assert.ok(lines.some((line) => line.includes("Session: 0.00 AIC used")));
		assert.ok(!lines.some((line) => line.includes("Plan:")));
	});

	it("clears the widget for another provider", () => {
		const harness = createHarness("openai");
		assert.equal(harness.widgets.get("copilot-credit"), undefined);
	});
});
