/**
 * codex-usage — current ChatGPT Codex quota in Pi's footer.
 *
 * The extension resolves the active OpenAI Codex OAuth token through Pi's
 * model registry, derives the account id from the token, and queries the fixed
 * ChatGPT Codex usage endpoint. It never logs or persists credentials or the
 * account-identifying fields returned by the endpoint.
 *
 * Disable with PI_CODEX_USAGE_DISABLE=1.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	codexUsageReportLines,
	formatCodexStatus,
	parseCodexUsage,
	type CodexUsage,
} from "./usage.ts";

const STATUS_KEY = "codex-usage";
const REPORT_KEY = "codex-usage-report";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REFRESH_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const DISABLED_VALUES = new Set(["1", "true", "yes"]);

type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

type UsageResult =
	| { status: "ok"; value: CodexUsage }
	| { status: "error"; error: string };

export interface CodexUsageDependencies {
	fetch?: FetchLike;
	now?: () => number;
}

type RuntimeContext = ExtensionContext & {
	modelRegistry: ExtensionContext["modelRegistry"] & {
		getApiKeyAndHeaders(
			model: NonNullable<ExtensionContext["model"]>,
		): Promise<{ ok: true; apiKey?: string } | { ok: false; error: string }>;
	};
	ui: ExtensionContext["ui"] & {
		theme: { fg(color: string, text: string): string };
		setWidget(key: string, value: string[] | undefined): void;
	};
};

function isDisabled(): boolean {
	return DISABLED_VALUES.has(
		(process.env.PI_CODEX_USAGE_DISABLE ?? "").trim().toLowerCase(),
	);
}

function isCodexModel(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === "openai-codex";
}

function isAssistantMessage(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return false;
	return (value as Record<string, unknown>).role === "assistant";
}

function extractAccountId(accessToken: string): string | null {
	try {
		const parts = accessToken.split(".");
		if (parts.length !== 3) return null;
		const payload = JSON.parse(
			Buffer.from(parts[1], "base64url").toString("utf8"),
		) as Record<string, unknown>;
		const auth = payload[JWT_AUTH_CLAIM];
		if (typeof auth !== "object" || auth === null || Array.isArray(auth))
			return null;
		const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
		return typeof accountId === "string" && accountId.length > 0
			? accountId
			: null;
	} catch {
		return null;
	}
}

async function fetchCodexUsage(
	ctx: RuntimeContext,
	fetchImpl: FetchLike,
): Promise<UsageResult> {
	if (!ctx.model || ctx.model.provider !== "openai-codex") {
		return { status: "error", error: "select an openai-codex model" };
	}

	const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!resolved.ok || !resolved.apiKey) {
		return { status: "error", error: "Codex OAuth unavailable; run /login" };
	}
	const accountId = extractAccountId(resolved.apiKey);
	if (!accountId) {
		return { status: "error", error: "Codex OAuth token has no account id" };
	}

	let response: Response;
	try {
		response = await fetchImpl(USAGE_URL, {
			headers: {
				accept: "application/json",
				Authorization: `Bearer ${resolved.apiKey}`,
				"ChatGPT-Account-ID": accountId,
				originator: "pi",
				"User-Agent": "pi-codex-usage",
			},
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch {
		return { status: "error", error: "usage request failed or timed out" };
	}

	if (!response.ok) {
		if (response.status === 401 || response.status === 403) {
			return { status: "error", error: "Codex OAuth rejected; run /login" };
		}
		return {
			status: "error",
			error: `usage endpoint returned HTTP ${response.status}`,
		};
	}

	let payload: unknown;
	try {
		payload = (await response.json()) as unknown;
	} catch {
		return { status: "error", error: "usage endpoint returned invalid JSON" };
	}
	const parsed = parseCodexUsage(payload);
	if (!parsed.ok)
		return { status: "error", error: `invalid usage response: ${parsed.error}` };
	return { status: "ok", value: parsed.value };
}

export function registerCodexUsageExtension(
	pi: ExtensionAPI,
	dependencies: CodexUsageDependencies = {},
): void {
	const disabled = isDisabled();
	const fetchImpl = dependencies.fetch ?? globalThis.fetch;
	const now = dependencies.now ?? Date.now;
	let cache: { fetchedAt: number; value: CodexUsage } | null = null;
	let lastError: string | null = null;
	let refreshPromise: Promise<UsageResult> | null = null;

	function clearUi(ctx: RuntimeContext): void {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(REPORT_KEY, undefined);
	}

	function renderStatus(ctx: RuntimeContext): void {
		if (disabled || !isCodexModel(ctx)) {
			clearUi(ctx);
			return;
		}
		if (cache) {
			const text = formatCodexStatus(cache.value);
			const color = cache.value.rateLimit.limitReached ? "warning" : "dim";
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, text));
			return;
		}
		const text = lastError ? "Codex quota unavailable" : "Codex quota loading…";
		ctx.ui.setStatus(
			STATUS_KEY,
			ctx.ui.theme.fg(lastError ? "warning" : "dim", text),
		);
	}

	async function refresh(
		ctx: RuntimeContext,
		force = false,
	): Promise<UsageResult> {
		if (!force && cache && now() - cache.fetchedAt < REFRESH_TTL_MS) {
			return { status: "ok", value: cache.value };
		}
		if (refreshPromise) return refreshPromise;
		refreshPromise = fetchCodexUsage(ctx, fetchImpl)
			.then((result) => {
				if (result.status === "ok") {
					cache = { fetchedAt: now(), value: result.value };
					lastError = null;
				} else {
					lastError = result.error;
				}
				return result;
			})
			.finally(() => {
				refreshPromise = null;
			});
		return refreshPromise;
	}

	async function refreshAndRender(
		ctx: RuntimeContext,
		force = false,
	): Promise<UsageResult> {
		const result = await refresh(ctx, force);
		renderStatus(ctx);
		return result;
	}

	pi.on("session_start", (_event, extensionCtx) => {
		const ctx = extensionCtx as RuntimeContext;
		ctx.ui.setWidget(REPORT_KEY, undefined);
		renderStatus(ctx);
		if (!disabled && isCodexModel(ctx)) void refreshAndRender(ctx);
	});

	pi.on("model_select", (_event, extensionCtx) => {
		const ctx = extensionCtx as RuntimeContext;
		ctx.ui.setWidget(REPORT_KEY, undefined);
		renderStatus(ctx);
		if (!disabled && isCodexModel(ctx)) void refreshAndRender(ctx);
	});

	pi.on("before_agent_start", (_event, extensionCtx) => {
		const ctx = extensionCtx as RuntimeContext;
		// `/reload` does not guarantee that session_start is replayed for newly
		// loaded extension instances. Reconcile against the live model before
		// every turn; refresh() keeps this network-cheap through its TTL cache.
		renderStatus(ctx);
		if (!disabled && isCodexModel(ctx)) void refreshAndRender(ctx);
	});

	pi.on("message_end", (event, extensionCtx) => {
		const ctx = extensionCtx as RuntimeContext;
		if (!disabled && isCodexModel(ctx) && isAssistantMessage(event.message)) {
			void refreshAndRender(ctx, true);
		}
	});

	pi.on("session_shutdown", (_event, extensionCtx) => {
		clearUi(extensionCtx as RuntimeContext);
	});

	pi.registerCommand("codex-usage", {
		description:
			"Refresh Codex quota in the footer and show details: /codex-usage [clear]",
		handler: async (args: string, extensionCtx) => {
			const ctx = extensionCtx as RuntimeContext;
			if (disabled) {
				clearUi(ctx);
				ctx.ui.notify("codex-usage: disabled by PI_CODEX_USAGE_DISABLE", "warning");
				return;
			}
			if (!isCodexModel(ctx)) {
				clearUi(ctx);
				ctx.ui.notify("codex-usage: select an openai-codex model", "warning");
				return;
			}
			const command = args.trim().toLowerCase();
			if (command === "clear") {
				ctx.ui.setWidget(REPORT_KEY, undefined);
				ctx.ui.notify(
					"codex-usage: detailed report hidden; footer remains active",
					"info",
				);
				return;
			}
			if (command.length > 0) {
				ctx.ui.notify("codex-usage: usage /codex-usage [clear]", "warning");
				return;
			}

			ctx.ui.setStatus(
				STATUS_KEY,
				ctx.ui.theme.fg("dim", "Codex quota refreshing…"),
			);
			const result = await refreshAndRender(ctx, true);
			if (result.status === "error") {
				ctx.ui.setWidget(REPORT_KEY, [
					"Codex usage:",
					`  unavailable: ${result.error}`,
				]);
				return;
			}
			ctx.ui.setWidget(REPORT_KEY, codexUsageReportLines(result.value));
		},
	});
}

export default function codexUsageExtension(pi: ExtensionAPI): void {
	registerCodexUsageExtension(pi);
}
