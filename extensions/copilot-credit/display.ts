import type { UsageTotals } from "./usage.ts";
import {
	businessDaysElapsed,
	businessDaysInMonth,
	dailyCreditBudget,
	type CopilotQuota,
	type UtcMonthPeriod,
} from "./usage.ts";

/** Copilot CLI-style monthly plan meter: `Plan: 207/300 (69% used)`. */
export function planSegment(quota: CopilotQuota | null | undefined): string | null {
	const premium = quota?.categories.premium_interactions;
	if (!premium || premium.unlimited || premium.entitlement === null || premium.remaining === null) return null;
	const used = Math.max(0, premium.entitlement - premium.remaining);
	const percent = Math.round((used / premium.entitlement) * 100);
	return `Plan: ${used.toLocaleString("en-US")}/${premium.entitlement.toLocaleString("en-US")} (${percent}% used)`;
}

/** Copilot CLI-style session meter: `Session: 2.12 AIC used`. */
export function sessionSegment(totals: UsageTotals): string {
	const incomplete = totals.creditsComplete ? "" : " +?";
	return `Session: ${totals.grossCredits.toFixed(2)} AIC used${incomplete}`;
}

/** Compact per-day budget for the credit widget, or null when not computable. */
export function perDaySegment(
	quota: CopilotQuota,
	period: UtcMonthPeriod,
	now: Date,
	holidays: ReadonlySet<string>,
): string | null {
	const budget = dailyCreditBudget(quota, period, now, holidays);
	if (!budget) return null;
	return `${budget.perDay.toFixed(1)} AIC/day`;
}

/** Single credit-widget line in GitHub Copilot CLI style. */
export function creditWidgetLine(
	totals: UsageTotals,
	quota: CopilotQuota | null | undefined,
	period: UtcMonthPeriod,
	now: Date,
	holidays: ReadonlySet<string>,
): string {
	const plan = planSegment(quota);
	const session = sessionSegment(totals);
	let text = plan ? `${plan} · ${session}` : session;
	if (quota) {
		const perDay = perDaySegment(quota, period, now, holidays);
		if (perDay) text += ` · ${perDay}`;
	}
	return text;
}

function formatQuotaResetDate(resetDateUtc: string): string {
	const date = resetDateUtc.slice(0, 10);
	return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date} UTC` : resetDateUtc;
}

/** Detailed monthly quota lines for the /copilot-credit report. */
export function quotaReportLines(quota: CopilotQuota | null | undefined): string[] {
	if (!quota) return ["  not requested · run /copilot-credit"];
	const premium = quota.categories.premium_interactions;
	if (!premium) return ["  no premium-request quota reported for this account"];

	const lines: string[] = [];
	if (premium.unlimited) {
		lines.push("  premium requests: unlimited");
	} else if (premium.entitlement !== null && premium.remaining !== null) {
		const consumed = premium.entitlement - premium.remaining;
		const used = Math.min(Math.max(0, consumed), premium.entitlement);
		const pct = premium.percentRemaining !== null ? ` · ${premium.percentRemaining}% remaining` : "";
		lines.push(`  premium requests: ${used} used / ${premium.entitlement} limit${pct}`);
	} else if (premium.remaining !== null) {
		lines.push(`  premium requests: ${premium.remaining} remaining`);
	} else if (premium.percentRemaining !== null) {
		lines.push(`  premium requests: ${premium.percentRemaining}% remaining`);
	}
	if (premium.overageCount !== null && premium.overageCount > 0) {
		lines.push(`  overage: +${premium.overageCount}${premium.overagePermitted === true ? " (permitted)" : ""}`);
	}
	if (quota.plan) lines.push(`  plan: ${quota.plan}`);
	if (quota.resetDateUtc) lines.push(`  reset: ${formatQuotaResetDate(quota.resetDateUtc)}`);
	return lines;
}

/** Detailed per-remaining-business-day budget line for the /copilot-credit report. */
export function quotaPerDayLine(
	quota: CopilotQuota,
	period: UtcMonthPeriod,
	now: Date,
	holidays: ReadonlySet<string>,
): string | null {
	const budget = dailyCreditBudget(quota, period, now, holidays);
	if (!budget) return null;
	return (
		`  per remaining business day: ${budget.perDay.toFixed(1)} cr` +
		` (${budget.remainingCredits} cr / ${budget.remainingBusinessDays} business days)`
	);
}

export { businessDaysElapsed, businessDaysInMonth };
