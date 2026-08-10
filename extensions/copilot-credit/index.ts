/**
 * copilot-credit — monthly credit quota and per-day budget for the GitHub
 * Copilot provider, shown as a standalone widget in GitHub Copilot CLI style
 * (`Plan: 207/300 (69% used) · Session: 2.12 AIC used · 5.5 AIC/day`).
 *
 * The widget is present only while `github-copilot` is selected. The monthly
 * quota is read from the already-authenticated `gh` CLI via the
 * `copilot_internal/user` endpoint and cached for 60 seconds. Session credit
 * comes from Pi's session files via the shared copilot-shared aggregation module.
 *
 * Disable with PI_COPILOT_USAGE_DISABLE=1.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { creditWidgetLine, quotaPerDayLine, quotaReportLines } from "./display.ts";
import {
	aggregateSessionEntries,
	currentUtcMonth,
	isCopilotModel,
	isCopilotUsageDisabled,
	japaneseHolidays,
	parseCopilotQuota,
	type CopilotQuota,
	type UsageTotals,
} from "./usage.ts";

const WIDGET_KEY = "copilot-credit";
const REPORT_KEY = "copilot-credit-report";
const QUOTA_PATH = "copilot_internal/user";
const GITHUB_API_VERSION = "2026-03-10";
const GH_TIMEOUT_MS = 15_000;
const QUOTA_CACHE_TTL_MS = 60_000;

type QuotaResult =
	| { status: "ok"; value: CopilotQuota }
	| { status: "error"; error: string };

async function fetchCopilotQuota(pi: ExtensionAPI): Promise<QuotaResult> {
	let result: Awaited<ReturnType<ExtensionAPI["exec"]>>;
	try {
		result = await pi.exec(
			"gh",
			[
				"api",
				"--hostname",
				"github.com",
				"--method",
				"GET",
				"-H",
				"Accept: application/vnd.github+json",
				"-H",
				`X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
				QUOTA_PATH,
			],
			{ timeout: GH_TIMEOUT_MS },
		);
	} catch {
		return { status: "error", error: "gh api could not start or timed out" };
	}
	if (result.code !== 0) {
		return { status: "error", error: `gh api failed while reading GitHub Copilot quota (exit ${result.code})` };
	}

	let payload: unknown;
	try {
		payload = JSON.parse(result.stdout) as unknown;
	} catch {
		return { status: "error", error: "GitHub Copilot usage API returned invalid JSON" };
	}
	const parsed = parseCopilotQuota(payload);
	if (!parsed.ok) {
		return { status: "error", error: `invalid GitHub Copilot quota response: ${parsed.error}` };
	}
	return { status: "ok", value: parsed.value };
}

export default function copilotCreditExtension(pi: ExtensionAPI): void {
	const disabled = isCopilotUsageDisabled();
	let quotaCache: { fetchedAt: number; result: QuotaResult } | null = null;
	let quotaRefresh: Promise<QuotaResult> | null = null;
	let holidaysCache: { year: number; holidays: Set<string> } | null = null;

	function holidaysForYear(year: number): Set<string> {
		if (!holidaysCache || holidaysCache.year !== year) {
			holidaysCache = { year, holidays: japaneseHolidays(year) };
		}
		return holidaysCache.holidays;
	}

	async function refreshQuota(force = false): Promise<QuotaResult> {
		if (force) {
			const result = await fetchCopilotQuota(pi);
			quotaCache = { fetchedAt: Date.now(), result };
			return result;
		}
		const fresh = quotaCache !== null && Date.now() - quotaCache.fetchedAt < QUOTA_CACHE_TTL_MS;
		if (fresh) return quotaCache!.result;
		if (quotaRefresh) return quotaRefresh;
		quotaRefresh = fetchCopilotQuota(pi)
			.then((result) => {
				quotaCache = { fetchedAt: Date.now(), result };
				return result;
			})
			.finally(() => {
				quotaRefresh = null;
			});
		return quotaRefresh;
	}

	function sessionTotals(ctx: ExtensionContext): UsageTotals {
		return aggregateSessionEntries(ctx.sessionManager.getBranch());
	}

	function clearWidget(ctx: ExtensionContext): void {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		ctx.ui.setWidget(REPORT_KEY, undefined);
	}

	function renderWidget(ctx: ExtensionContext): void {
		if (disabled || !isCopilotModel(ctx.model)) {
			clearWidget(ctx);
			return;
		}
		const quota = quotaCache?.result.status === "ok" ? quotaCache.result.value : undefined;
		const now = new Date();
		const line = creditWidgetLine(
			sessionTotals(ctx),
			quota,
			currentUtcMonth(now),
			now,
			holidaysForYear(now.getUTCFullYear()),
		);
		ctx.ui.setWidget(WIDGET_KEY, [line]);
	}

	async function refreshQuotaAndRender(ctx: ExtensionContext, force = false): Promise<void> {
		await refreshQuota(force);
		renderWidget(ctx);
	}

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setWidget(REPORT_KEY, undefined);
		renderWidget(ctx);
		if (!disabled && isCopilotModel(ctx.model)) void refreshQuotaAndRender(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		ctx.ui.setWidget(REPORT_KEY, undefined);
		renderWidget(ctx);
		if (!disabled && isCopilotModel(ctx.model)) void refreshQuotaAndRender(ctx);
	});

	pi.on("message_end", (event, ctx) => {
		if (disabled) return;
		if (event.message.role !== "assistant" || event.message.provider !== "github-copilot") return;
		renderWidget(ctx);
	});

	pi.on("agent_end", (_event, ctx) => renderWidget(ctx));
	pi.on("session_tree", (_event, ctx) => renderWidget(ctx));
	pi.on("session_compact", (_event, ctx) => renderWidget(ctx));
	pi.on("session_shutdown", (_event, ctx) => clearWidget(ctx));

	pi.registerCommand("copilot-credit", {
		description: "Show Copilot monthly credit quota and per-day budget: /copilot-credit [clear]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (disabled) {
				clearWidget(ctx);
				ctx.ui.notify("copilot-credit: disabled by PI_COPILOT_USAGE_DISABLE", "warning");
				return;
			}
			if (!isCopilotModel(ctx.model)) {
				clearWidget(ctx);
				ctx.ui.notify("copilot-credit: inactive for provider; select github-copilot", "warning");
				return;
			}
			if (args.trim().toLowerCase() === "clear") {
				clearWidget(ctx);
				ctx.ui.notify("copilot-credit: widget hidden", "info");
				return;
			}

			const quota = await refreshQuota(true);
			const totals = sessionTotals(ctx);
			const now = new Date();
			const period = currentUtcMonth(now);
			const holidays = holidaysForYear(now.getUTCFullYear());

			const lines: string[] = ["GitHub Copilot monthly credit:"];
			if (quota.status === "error") {
				lines.push(`  unavailable: ${quota.error}`);
			} else {
				lines.push(...quotaReportLines(quota.value));
				const perDay = quotaPerDayLine(quota.value, period, now, holidays);
				if (perDay) lines.push(perDay);
				lines.push("  quota is from gh's account; it may differ from Pi's Copilot account");
			}
			lines.push(`  session: ${totals.grossCredits.toFixed(2)} AIC used (local estimate)`);
			ctx.ui.setWidget(REPORT_KEY, lines);
			renderWidget(ctx);
		},
	});
}
