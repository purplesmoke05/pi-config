export interface CodexUsageWindow {
	usedPercent: number;
	limitWindowSeconds: number;
	resetAfterSeconds: number;
	resetAt: number;
}

export interface CodexRateLimit {
	allowed: boolean;
	limitReached: boolean;
	primaryWindow: CodexUsageWindow;
	secondaryWindow: CodexUsageWindow | null;
}

export interface CodexAdditionalRateLimit {
	name: string;
	rateLimit: CodexRateLimit;
}

export interface CodexCredits {
	hasCredits: boolean;
	unlimited: boolean;
	balance: string | null;
}

export interface CodexUsage {
	planType: string | null;
	rateLimit: CodexRateLimit;
	additionalRateLimits: CodexAdditionalRateLimit[];
	credits: CodexCredits | null;
}

export type CodexUsageParseResult =
	| { ok: true; value: CodexUsage }
	| { ok: false; error: string };

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseWindow(value: unknown): CodexUsageWindow | null {
	const raw = record(value);
	if (!raw) return null;
	const usedPercent = finiteNumber(raw.used_percent);
	const limitWindowSeconds = finiteNumber(raw.limit_window_seconds);
	const resetAfterSeconds = finiteNumber(raw.reset_after_seconds);
	const resetAt = finiteNumber(raw.reset_at);
	if (
		usedPercent === null ||
		limitWindowSeconds === null ||
		resetAfterSeconds === null ||
		resetAt === null
	) {
		return null;
	}
	return {
		usedPercent: Math.min(100, Math.max(0, usedPercent)),
		limitWindowSeconds: Math.max(0, limitWindowSeconds),
		resetAfterSeconds: Math.max(0, resetAfterSeconds),
		resetAt: Math.max(0, resetAt),
	};
}

function parseRateLimit(value: unknown): CodexRateLimit | null {
	const raw = record(value);
	if (!raw) return null;
	const primaryWindow = parseWindow(raw.primary_window);
	if (!primaryWindow) return null;
	const secondaryWindow =
		raw.secondary_window == null ? null : parseWindow(raw.secondary_window);
	if (raw.secondary_window != null && !secondaryWindow) return null;
	return {
		allowed: raw.allowed !== false,
		limitReached: raw.limit_reached === true,
		primaryWindow,
		secondaryWindow,
	};
}

function parseCredits(value: unknown): CodexCredits | null {
	const raw = record(value);
	if (!raw) return null;
	return {
		hasCredits: raw.has_credits === true,
		unlimited: raw.unlimited === true,
		balance: typeof raw.balance === "string" ? raw.balance : null,
	};
}

export function parseCodexUsage(payload: unknown): CodexUsageParseResult {
	const raw = record(payload);
	if (!raw) return { ok: false, error: "response is not an object" };
	const rateLimit = parseRateLimit(raw.rate_limit);
	if (!rateLimit) return { ok: false, error: "missing or invalid rate_limit" };

	const additionalRateLimits: CodexAdditionalRateLimit[] = [];
	if (Array.isArray(raw.additional_rate_limits)) {
		for (const entry of raw.additional_rate_limits) {
			const item = record(entry);
			if (!item || typeof item.limit_name !== "string") continue;
			const additionalRateLimit = parseRateLimit(item.rate_limit);
			if (additionalRateLimit)
				additionalRateLimits.push({
					name: item.limit_name,
					rateLimit: additionalRateLimit,
				});
		}
	}

	return {
		ok: true,
		value: {
			planType: typeof raw.plan_type === "string" ? raw.plan_type : null,
			rateLimit,
			additionalRateLimits,
			credits: parseCredits(raw.credits),
		},
	};
}

export function remainingPercent(window: CodexUsageWindow): number {
	return Math.max(0, Math.round(100 - window.usedPercent));
}

export function formatDuration(totalSeconds: number): string {
	const seconds = Math.max(0, Math.floor(totalSeconds));
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3_600);
	const minutes = Math.floor((seconds % 3_600) / 60);
	if (days > 0) return `${days}d${hours}h`;
	if (hours > 0) return `${hours}h${minutes}m`;
	return `${minutes}m`;
}

function windowLabel(window: CodexUsageWindow): string {
	const hours = window.limitWindowSeconds / 3_600;
	if (hours >= 4 && hours <= 6) return "5h";
	if (hours >= 144 && hours <= 192) return "wk";
	if (hours >= 600 && hours <= 768) return "mo";
	return hours >= 24
		? `${Math.round(hours / 24)}d`
		: `${Math.max(1, Math.round(hours))}h`;
}

function compactWindow(window: CodexUsageWindow): string {
	return `${windowLabel(window)} ${remainingPercent(window)}%`;
}

export function formatCodexStatus(usage: CodexUsage): string {
	const { rateLimit } = usage;
	if (rateLimit.limitReached || !rateLimit.allowed) {
		return `Codex limit · reset ${formatDuration(rateLimit.primaryWindow.resetAfterSeconds)}`;
	}
	if (rateLimit.secondaryWindow) {
		return `Codex ${compactWindow(rateLimit.primaryWindow)} · ${compactWindow(rateLimit.secondaryWindow)} left`;
	}
	return `Codex ${compactWindow(rateLimit.primaryWindow)} left · reset ${formatDuration(rateLimit.primaryWindow.resetAfterSeconds)}`;
}

function formatResetAt(epochSeconds: number): string {
	const date = new Date(epochSeconds * 1_000);
	if (Number.isNaN(date.getTime())) return "unknown";
	return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function rateLimitReportLines(
	label: string,
	rateLimit: CodexRateLimit,
): string[] {
	const lines = [
		`  ${label} ${windowLabel(rateLimit.primaryWindow)}: ${Math.round(rateLimit.primaryWindow.usedPercent)}% used / ${remainingPercent(rateLimit.primaryWindow)}% remaining`,
		`    reset: ${formatResetAt(rateLimit.primaryWindow.resetAt)} (${formatDuration(rateLimit.primaryWindow.resetAfterSeconds)})`,
	];
	if (rateLimit.secondaryWindow) {
		lines.push(
			`  ${label} ${windowLabel(rateLimit.secondaryWindow)}: ${Math.round(rateLimit.secondaryWindow.usedPercent)}% used / ${remainingPercent(rateLimit.secondaryWindow)}% remaining`,
			`    reset: ${formatResetAt(rateLimit.secondaryWindow.resetAt)} (${formatDuration(rateLimit.secondaryWindow.resetAfterSeconds)})`,
		);
	}
	return lines;
}

export function codexUsageReportLines(usage: CodexUsage): string[] {
	const lines = ["Codex usage:"];
	if (usage.planType) lines.push(`  plan: ${usage.planType}`);
	lines.push(...rateLimitReportLines("main", usage.rateLimit));
	for (const additional of usage.additionalRateLimits) {
		lines.push(...rateLimitReportLines(additional.name, additional.rateLimit));
	}
	if (usage.credits) {
		if (usage.credits.unlimited) lines.push("  credits: unlimited");
		else if (usage.credits.hasCredits && usage.credits.balance !== null)
			lines.push(`  credits: ${usage.credits.balance}`);
		else lines.push("  credits: none");
	}
	lines.push("  source: ChatGPT Codex usage endpoint (undocumented)");
	return lines;
}
