/**
 * copilot-usage — local token/credit visibility for the GitHub Copilot provider.
 *
 * The footer is present only while `github-copilot` is selected. Provider
 * payloads are inspected in memory immediately before sending; they are never
 * logged. Historical totals come from Pi's session files. The extension never
 * reads Pi or GitHub credential files. `/copilot-usage official` delegates an
 * explicit account-level billing lookup to the already-authenticated `gh` CLI.
 *
 * Disable with PI_COPILOT_USAGE_DISABLE=1.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	PRICING_SNAPSHOT_DATE,
	PRICING_EFFECTIVE_FROM,
	PRICING_SOURCE,
	aggregateHistory,
	aggregateSessionEntries,
	currentUtcMonth,
	estimateProviderPayload,
	isCopilotModel,
	isCopilotUsageDisabled,
	parseOfficialBillingReport,
	parseSessionJsonl,
	parseUtcMonth,
	type HistoryAggregate,
	type OfficialBillingSummary,
	type PayloadEstimate,
	type SessionRecord,
	type UsageAggregate,
	type UsageTotals,
	type UtcMonthPeriod,
} from "./usage.ts";

const STATUS_KEY = "copilot-usage";
const REPORT_KEY = "copilot-usage-report";
const GITHUB_API_VERSION = "2026-03-10";
const GH_TIMEOUT_MS = 15_000;
const GITHUB_LOGIN = /^(?!-)[A-Za-z0-9-]{1,39}(?<!-)$/;

interface LocalHistoryResult {
	history: HistoryAggregate;
	errors: string[];
}

type OfficialResult =
	| { status: "ok"; login: string; summary: OfficialBillingSummary }
	| { status: "error"; error: string };

type CommandRequest =
	| { mode: "local"; period: UtcMonthPeriod }
	| { mode: "official"; period: UtcMonthPeriod }
	| { mode: "clear" }
	| { mode: "invalid" };

function compactTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)}m`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
	return String(value);
}

function detailedNumber(value: number, maximumFractionDigits = 0): string {
	return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(value);
}

function credits(value: number): string {
	const digits = value < 1 ? 4 : value < 100 ? 3 : 2;
	return detailedNumber(value, digits);
}

function usd(value: number): string {
	return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

function inputTokens(totals: UsageTotals): number {
	return totals.input + totals.cacheRead + totals.cacheWrite;
}

function creditEstimate(totals: UsageTotals): string {
	return `≈${credits(totals.grossCredits)} cr${totals.creditsComplete ? "" : " +?"}`;
}

function formatPeriod(period: UtcMonthPeriod): string {
	return `${period.year}-${String(period.month).padStart(2, "0")}`;
}

function commandRequest(args: string): CommandRequest {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return { mode: "local", period: currentUtcMonth() };
	if (parts.length === 1 && parts[0] === "clear") return { mode: "clear" };
	if (parts.length === 1) {
		const period = parseUtcMonth(parts[0]);
		return period ? { mode: "local", period } : parts[0] === "official"
			? { mode: "official", period: currentUtcMonth() }
			: { mode: "invalid" };
	}
	if (parts.length === 2 && parts[0] === "official") {
		const period = parseUtcMonth(parts[1]);
		return period ? { mode: "official", period } : { mode: "invalid" };
	}
	return { mode: "invalid" };
}

function activeBranch(ctx: ExtensionContext, pending?: AssistantMessage): UsageAggregate {
	const entries: unknown[] = [...ctx.sessionManager.getBranch()];
	if (pending) entries.push({ type: "message", message: pending });
	return aggregateSessionEntries(entries);
}

function nextBaseInputEstimate(pi: ExtensionAPI, ctx: ExtensionContext): number | null {
	const activeTools = new Set(pi.getActiveTools());
	const tools = pi
		.getAllTools()
		.filter((tool) => activeTools.has(tool.name))
		.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		}));
	const estimate = estimateProviderPayload(
		{ system: ctx.getSystemPrompt(), tools },
		ctx.getContextUsage()?.tokens,
	);
	return estimate.ok ? estimate.tokens : null;
}

async function scanLocalHistory(period: UtcMonthPeriod): Promise<LocalHistoryResult> {
	const sessions = await SessionManager.listAll();
	const records: SessionRecord[] = [];
	const errors: string[] = [];

	for (const session of sessions) {
		const label = basename(session.path);
		try {
			const parsed = parseSessionJsonl(await readFile(session.path, "utf8"), label);
			records.push({ path: label, entries: parsed.entries });
			errors.push(...parsed.errors);
		} catch {
			errors.push(`${label}: session file could not be read`);
		}
	}

	const history = aggregateHistory(records, period);
	if (errors.length > 0) history.creditsComplete = false;
	return { history, errors };
}

function ghFailure(code: number, stderr: string, stage: "login" | "billing"): string {
	const lower = stderr.toLowerCase();
	if (lower.includes("http 403") || lower.includes("status 403")) {
		return "GitHub Billing API returned 403; check classic-PAT and account billing permissions";
	}
	if (lower.includes("http 404") || lower.includes("status 404")) {
		return "GitHub Billing API returned 404; the individual billing report may not apply to this account";
	}
	if (lower.includes("http 400") || lower.includes("http 422")) {
		return "GitHub Billing API rejected the requested month";
	}
	if (stage === "login") return `gh is not authenticated for github.com (exit ${code})`;
	return `gh api failed while reading GitHub billing (exit ${code})`;
}

async function fetchOfficialBilling(
	pi: ExtensionAPI,
	period: UtcMonthPeriod,
): Promise<OfficialResult> {
	let loginResult: Awaited<ReturnType<ExtensionAPI["exec"]>>;
	try {
		loginResult = await pi.exec(
			"gh",
			["api", "--hostname", "github.com", "user", "--jq", ".login"],
			{ timeout: GH_TIMEOUT_MS },
		);
	} catch {
		return { status: "error", error: "gh CLI was not found or could not be started" };
	}
	if (loginResult.code !== 0) {
		return { status: "error", error: ghFailure(loginResult.code, loginResult.stderr, "login") };
	}

	const login = loginResult.stdout.trim();
	if (!GITHUB_LOGIN.test(login)) {
		return { status: "error", error: "gh returned an invalid GitHub login" };
	}
	const endpoint =
		`/users/${encodeURIComponent(login)}/settings/billing/ai_credit/usage` +
		`?year=${period.year}&month=${period.month}`;

	let billingResult: Awaited<ReturnType<ExtensionAPI["exec"]>>;
	try {
		billingResult = await pi.exec(
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
				endpoint,
			],
			{ timeout: GH_TIMEOUT_MS },
		);
	} catch {
		return { status: "error", error: "gh api could not start or timed out" };
	}
	if (billingResult.code !== 0) {
		return { status: "error", error: ghFailure(billingResult.code, billingResult.stderr, "billing") };
	}

	let payload: unknown;
	try {
		payload = JSON.parse(billingResult.stdout) as unknown;
	} catch {
		return { status: "error", error: "GitHub Billing API returned invalid JSON" };
	}
	const parsed = parseOfficialBillingReport(payload);
	if (!parsed.ok) return { status: "error", error: `invalid GitHub billing response: ${parsed.error}` };
	if (parsed.value.year !== period.year || parsed.value.month !== period.month) {
		return { status: "error", error: "GitHub billing response timePeriod did not match the requested month" };
	}
	return { status: "ok", login, summary: parsed.value };
}

function tokenLines(label: string, totals: UsageTotals): string[] {
	return [
		`${label}: ${detailedNumber(totals.calls)} calls · ${detailedNumber(totals.totalTokens)} tokens`,
		`  input ${detailedNumber(inputTokens(totals))} = uncached ${detailedNumber(totals.input)}` +
			` + cache-read ${detailedNumber(totals.cacheRead)} + cache-write ${detailedNumber(totals.cacheWrite)}`,
		`  output ${detailedNumber(totals.output)} · local gross ${creditEstimate(totals)}`,
	];
}

function buildReport(
	branch: UsageAggregate,
	local: LocalHistoryResult,
	official: OfficialResult | null,
	latestRequest: PayloadEstimate | null,
): string[] {
	const { history, errors } = local;
	const lines = [
		`GitHub Copilot usage · ${formatPeriod(history.period)} UTC`,
		"",
		...tokenLines("active branch (lifetime)", branch),
	];
	if (branch.unattributedInternalCalls > 0) {
		lines.push(
			`  +? ${branch.unattributedInternalCalls} internal summary call(s): Pi did not persist provider or usage`,
		);
	}

	if (latestRequest) {
		lines.push(
			latestRequest.ok
				? `  sending input ≈${detailedNumber(latestRequest.tokens ?? 0)} tokens` +
					(latestRequest.images ? ` (${latestRequest.images} image estimate)` : "")
				: `  sending input unavailable: ${latestRequest.error ?? "unsupported payload"}`,
		);
	}

	lines.push(
		"",
		...tokenLines(`all Pi sessions (${formatPeriod(history.period)} UTC)`, history),
		`  scanned ${history.filesScanned} Pi-indexed files · removed ${history.duplicatesRemoved} fork copies`,
	);
	if (history.unattributedInternalCalls > 0) {
		lines.push(
			`  +? ${history.unattributedInternalCalls} internal summary call(s): provider/usage unavailable in Pi sessions`,
		);
	}

	const models = Object.entries(history.byModel).sort(
		([, left], [, right]) => right.grossCredits - left.grossCredits || right.totalTokens - left.totalTokens,
	);
	if (models.length > 0) {
		lines.push("", "by model:");
		for (const [model, totals] of models.slice(0, 8)) {
			lines.push(
				`  ${model}: ${detailedNumber(totals.calls)} calls · ${detailedNumber(totals.totalTokens)} tokens · ${creditEstimate(totals)}`,
			);
		}
	}

	if (errors.length > 0 || history.warnings.length > 0) {
		lines.push("", `local report incomplete (${errors.length + history.warnings.length} warning(s)):`);
		for (const warning of [...errors, ...history.warnings].slice(0, 4)) lines.push(`  ${warning}`);
	}

	lines.push("", "GitHub account billing:");
	if (!official) {
		lines.push("  not requested · run /copilot-usage official [YYYY-MM]");
	} else if (official.status === "error") {
		lines.push(`  unavailable: ${official.error}`);
	} else {
		const totals = official.summary.totals;
		lines.push(
			`  @${official.login}: gross ${credits(totals.grossCredits)} cr (${usd(totals.grossUsd)})`,
			`  discount ${credits(totals.discountCredits)} cr (${usd(totals.discountUsd)})` +
				` · net ${credits(totals.netCredits)} cr (${usd(totals.netUsd)})`,
			`  ${official.summary.items} billing item(s) · account-wide, not Pi-only`,
			`  @${official.login} is gh's account; it may differ from Pi's Copilot account`,
		);
		for (const warning of official.summary.warnings.slice(0, 3)) lines.push(`  warning: ${warning}`);
	}

	lines.push(
		"",
		`Local credits use Pi's recorded list-price cost; ${PRICING_EFFECTIVE_FROM}+ long-context calls use the ${PRICING_SNAPSHOT_DATE} GitHub table.`,
		"Outgoing input is conservative: ASCII ÷ 4, non-ASCII × 2, image heuristic, and never below Pi's context estimate.",
		`Pricing: ${PRICING_SOURCE}`,
		"/copilot-usage clear hides this report.",
	);
	return lines;
}

export default function copilotUsageExtension(pi: ExtensionAPI): void {
	const disabled = isCopilotUsageDisabled();
	let latestRequest: PayloadEstimate | null = null;

	function clearUi(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(REPORT_KEY, undefined);
	}

	function renderStatus(ctx: ExtensionContext, aggregate?: UsageAggregate): void {
		if (disabled || !isCopilotModel(ctx.model)) {
			clearUi(ctx);
			return;
		}
		const resolvedAggregate = aggregate ?? activeBranch(ctx);
		const request = latestRequest
			? latestRequest.ok
				? `sending ≈${compactTokens(latestRequest.tokens ?? 0)}`
				: "sending ≈?"
			: (() => {
					const nextBase = nextBaseInputEstimate(pi, ctx);
					return nextBase === null ? "next-base ≈?" : `next-base ≈${compactTokens(nextBase)}`;
				})();
		const status =
			`Copilot ${request} · branch ↑${compactTokens(inputTokens(resolvedAggregate))}` +
			` ↓${compactTokens(resolvedAggregate.output)} · ${creditEstimate(resolvedAggregate)}`;
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", status));
	}

	pi.on("session_start", (_event, ctx) => {
		latestRequest = null;
		ctx.ui.setWidget(REPORT_KEY, undefined);
		renderStatus(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		latestRequest = null;
		renderStatus(ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (disabled || !isCopilotModel(ctx.model)) {
			clearUi(ctx);
			return;
		}
		latestRequest = estimateProviderPayload(event.payload, ctx.getContextUsage()?.tokens);
		renderStatus(ctx);
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (disabled) return;
		if (message.role !== "assistant" || message.provider !== "github-copilot") return;
		latestRequest = null;
		renderStatus(ctx, activeBranch(ctx, message));
	});

	pi.on("agent_end", (_event, ctx) => renderStatus(ctx));
	pi.on("session_tree", (_event, ctx) => {
		latestRequest = null;
		renderStatus(ctx);
	});
	pi.on("session_compact", (_event, ctx) => renderStatus(ctx));
	pi.on("session_shutdown", (_event, ctx) => clearUi(ctx));

	pi.registerCommand("copilot-usage", {
		description: "Show Copilot token/credit usage: /copilot-usage [YYYY-MM|official [YYYY-MM]|clear]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (disabled) {
				clearUi(ctx);
				ctx.ui.notify("copilot-usage: disabled by PI_COPILOT_USAGE_DISABLE", "warning");
				return;
			}
			if (!isCopilotModel(ctx.model)) {
				clearUi(ctx);
				ctx.ui.notify(
					`copilot-usage: inactive for provider ${ctx.model?.provider ?? "none"}; select github-copilot`,
					"warning",
				);
				return;
			}

			const request = commandRequest(args);
			if (request.mode === "invalid") {
				ctx.ui.notify(
					"copilot-usage: usage /copilot-usage [YYYY-MM|official [YYYY-MM]|clear]",
					"warning",
				);
				return;
			}
			if (request.mode === "clear") {
				ctx.ui.setWidget(REPORT_KEY, undefined);
				ctx.ui.notify("copilot-usage: report hidden", "info");
				return;
			}

			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "Copilot usage · scanning sessions…"));
			let local: LocalHistoryResult;
			try {
				local = await scanLocalHistory(request.period);
			} catch {
				const empty = aggregateHistory([], request.period);
				empty.creditsComplete = false;
				local = { history: empty, errors: ["Pi session index could not be read"] };
			}

			const official = request.mode === "official" ? await fetchOfficialBilling(pi, request.period) : null;
			const branch = activeBranch(ctx);
			ctx.ui.setWidget(REPORT_KEY, buildReport(branch, local, official, latestRequest));
			renderStatus(ctx, branch);
		},
	});
}
