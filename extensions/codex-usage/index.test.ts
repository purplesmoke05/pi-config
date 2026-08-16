import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerCodexUsageExtension } from "./index.ts";

type EventHandler = (
	event: Record<string, unknown>,
	ctx: ExtensionContext,
) => unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => unknown;

const QUOTA_PAYLOAD = {
	plan_type: "pro",
	rate_limit: {
		allowed: true,
		limit_reached: false,
		primary_window: {
			used_percent: 86,
			limit_window_seconds: 604_800,
			reset_after_seconds: 325_000,
			reset_at: 1_787_219_466,
		},
		secondary_window: null,
	},
	additional_rate_limits: [],
	credits: { has_credits: false, unlimited: false, balance: "0" },
};

function accessToken(accountId = "account-test"): string {
	const encode = (value: unknown): string =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none" })}.${encode({
		"https://api.openai.com/auth": { chatgpt_account_id: accountId },
	})}.signature`;
}

function createHarness(
	provider = "openai-codex",
	payload: unknown = QUOTA_PAYLOAD,
) {
	const handlers = new Map<string, EventHandler[]>();
	const commands = new Map<string, CommandHandler>();
	const statuses = new Map<string, string | undefined>();
	const widgets = new Map<string, string[] | undefined>();
	const requests: Array<{ url: string; headers: Headers }> = [];

	const pi = {
		on(event: string, handler: EventHandler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name: string, command: { handler: CommandHandler }) {
			commands.set(name, command.handler);
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		model: { provider, id: "gpt-5.6-sol" },
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: accessToken() }),
		},
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: (key: string, value: string | undefined) =>
				statuses.set(key, value),
			setWidget: (key: string, value: string[] | undefined) =>
				widgets.set(key, value),
			notify() {},
		},
	} as unknown as ExtensionContext;
	const fetchImpl = async (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		requests.push({ url: String(input), headers: new Headers(init?.headers) });
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};

	registerCodexUsageExtension(pi, { fetch: fetchImpl, now: () => 1_000_000 });
	const emit = async (
		type: string,
		event: Record<string, unknown>,
	): Promise<void> => {
		await Promise.all(
			(handlers.get(type) ?? []).map((handler) => handler(event, ctx)),
		);
		await new Promise((resolve) => setImmediate(resolve));
	};
	return { commands, ctx, emit, requests, statuses, widgets };
}

describe("codex-usage footer", () => {
	it("loads quota on session start and publishes a compact footer status", async () => {
		const harness = createHarness();
		await harness.emit("session_start", {});
		assert.equal(
			harness.statuses.get("codex-usage"),
			"Codex wk 14% left · reset 3d18h",
		);
		assert.equal(harness.requests.length, 1);
		assert.equal(
			harness.requests[0]?.url,
			"https://chatgpt.com/backend-api/wham/usage",
		);
		assert.equal(
			harness.requests[0]?.headers.get("chatgpt-account-id"),
			"account-test",
		);
		assert.match(
			harness.requests[0]?.headers.get("authorization") ?? "",
			/^Bearer /,
		);
	});

	it("does not display or fetch quota for another provider", async () => {
		const harness = createHarness("openai");
		await harness.emit("session_start", {});
		assert.equal(harness.statuses.get("codex-usage"), undefined);
		assert.equal(harness.requests.length, 0);
	});

	it("honors the PI_CODEX_USAGE_DISABLE kill switch", {
		concurrency: false,
	}, async () => {
		const previous = process.env.PI_CODEX_USAGE_DISABLE;
		process.env.PI_CODEX_USAGE_DISABLE = "1";
		try {
			const harness = createHarness();
			await harness.emit("session_start", {});
			assert.equal(harness.statuses.get("codex-usage"), undefined);
			assert.equal(harness.requests.length, 0);
		} finally {
			if (previous === undefined) delete process.env.PI_CODEX_USAGE_DISABLE;
			else process.env.PI_CODEX_USAGE_DISABLE = previous;
		}
	});

	it("refreshes after a Codex assistant message", async () => {
		const harness = createHarness();
		await harness.emit("session_start", {});
		await harness.emit("message_end", {
			message: { role: "assistant", provider: "openai-codex" },
		});
		assert.equal(harness.requests.length, 2);
	});

	it("restores the footer after an extension hot reload", async () => {
		const harness = createHarness();
		// Pi can reload an extension without replaying session_start. The next
		// assistant completion must derive provider state from the live context.
		await harness.emit("message_end", {
			// Some Pi lifecycle paths omit provider from the message payload even
			// though the live ExtensionContext still has the selected model.
			message: { role: "assistant" },
		});
		assert.equal(
			harness.statuses.get("codex-usage"),
			"Codex wk 14% left · reset 3d18h",
		);
		assert.equal(harness.requests.length, 1);
	});

	it("reconciles the footer before the first post-reload turn", async () => {
		const harness = createHarness();
		await harness.emit("before_agent_start", { prompt: "test" });
		assert.equal(
			harness.statuses.get("codex-usage"),
			"Codex wk 14% left · reset 3d18h",
		);
		assert.equal(harness.requests.length, 1);
	});

	it("shows details on command while keeping account data out of the report", async () => {
		const harness = createHarness();
		const command = harness.commands.get("codex-usage");
		assert.ok(command);
		await command("", harness.ctx);
		const report = harness.widgets.get("codex-usage-report")?.join("\n") ?? "";
		assert.match(report, /Codex usage:/);
		assert.match(report, /14% remaining/);
		assert.doesNotMatch(report, /account-test|authorization/i);
	});
});
