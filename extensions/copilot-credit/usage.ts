import {
	aggregateSessionEntries,
	currentUtcMonth,
	finiteNonNegativeInteger,
	finiteNonNegativeNumber,
	isCopilotModel,
	isCopilotUsageDisabled,
	isRecord,
	utcMonthPeriod,
	type UsageTotals,
	type UtcMonthPeriod,
} from "../copilot-shared/usage.ts";

export interface CopilotQuotaCategory {
	entitlement: number | null;
	remaining: number | null;
	percentRemaining: number | null;
	unlimited: boolean | null;
	overageCount: number | null;
	overagePermitted: boolean | null;
}

export interface CopilotQuota {
	login: string | null;
	plan: string | null;
	resetDateUtc: string | null;
	categories: Partial<Record<"premium_interactions" | "chat" | "completions", CopilotQuotaCategory>>;
}

export type CopilotQuotaParseResult =
	| { ok: true; value: CopilotQuota }
	| { ok: false; error: string };

function pickField(record: Record<string, unknown>, camel: string, snake: string): unknown {
	return record[camel] ?? record[snake];
}

function parseQuotaCategory(value: unknown): CopilotQuotaCategory | null {
	if (!isRecord(value)) return null;
	const entitlement = finiteNonNegativeInteger(pickField(value, "entitlement", "entitlement"));
	const remaining = finiteNonNegativeInteger(pickField(value, "remaining", "quota_remaining"));
	const percentRemaining = finiteNonNegativeNumber(pickField(value, "percentRemaining", "percent_remaining"));
	const overageCount = finiteNonNegativeInteger(pickField(value, "overageCount", "overage_count"));
	const unlimitedValue = pickField(value, "unlimited", "unlimited");
	const overagePermittedValue = pickField(value, "overagePermitted", "overage_permitted");
	const unlimited = typeof unlimitedValue === "boolean" ? unlimitedValue : null;
	const overagePermitted = typeof overagePermittedValue === "boolean" ? overagePermittedValue : null;
	if (
		entitlement === null &&
		remaining === null &&
		percentRemaining === null &&
		overageCount === null &&
		unlimited === null
	) {
		return null;
	}
	return { entitlement, remaining, percentRemaining, unlimited, overageCount, overagePermitted };
}

export function parseCopilotQuota(payload: unknown): CopilotQuotaParseResult {
	if (!isRecord(payload)) return { ok: false, error: "quota response is not an object" };

	const login = typeof payload.login === "string" ? payload.login : null;
	const plan =
		typeof payload.copilot_plan === "string"
			? payload.copilot_plan
			: typeof payload.plan === "string"
				? payload.plan
				: null;
	const resetDateUtc =
		typeof payload.quota_reset_date_utc === "string"
			? payload.quota_reset_date_utc
			: typeof payload.quota_reset_date === "string"
				? payload.quota_reset_date
				: null;

	const categories: CopilotQuota["categories"] = {};
	const snapshotsValue = payload.quota_snapshots;
	if (isRecord(snapshotsValue)) {
		for (const key of ["premium_interactions", "chat", "completions"] as const) {
			const category = parseQuotaCategory(snapshotsValue[key]);
			if (category) categories[key] = category;
		}
	}
	if (!categories.premium_interactions) {
		const legacy = parseQuotaCategory(payload);
		if (legacy && (legacy.entitlement !== null || legacy.remaining !== null || legacy.percentRemaining !== null)) {
			categories.premium_interactions = legacy;
		}
	}

	if (Object.keys(categories).length === 0) {
		return { ok: false, error: "quota response has no recognized quota fields" };
	}
	return { ok: true, value: { login, plan, resetDateUtc, categories } };
}

function isoDate(date: Date): string {
	return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function vernalEquinoxDay(year: number): number {
	return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

function autumnalEquinoxDay(year: number): number {
	return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

/**
 * Japanese national holidays for a year, as ISO date strings. Includes fixed
 * and floating holidays, the astronomical equinox days, substitute holidays
 * (振替休日) for holidays falling on Sunday, and citizen's holidays (国民の休日)
 * sandwiched between two holidays. Valid for years 1980-2099.
 */
export function japaneseHolidays(year: number): Set<string> {
	const holidays = new Set<string>();
	const add = (month: number, day: number): void => {
		holidays.add(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
	};
	const addNthWeekday = (month: number, weekday: number, n: number): void => {
		const first = new Date(Date.UTC(year, month - 1, 1));
		const offset = (weekday - first.getUTCDay() + 7) % 7;
		add(month, 1 + offset + (n - 1) * 7);
	};

	add(1, 1); // 元日
	addNthWeekday(1, 1, 2); // 成人の日
	add(2, 11); // 建国記念の日
	add(2, 23); // 天皇誕生日
	add(3, vernalEquinoxDay(year)); // 春分の日
	add(4, 29); // 昭和の日
	add(5, 3); // 憲法記念日
	add(5, 4); // みどりの日
	add(5, 5); // こどもの日
	addNthWeekday(7, 1, 3); // 海の日
	add(8, 11); // 山の日
	addNthWeekday(9, 1, 3); // 敬老の日
	add(9, autumnalEquinoxDay(year)); // 秋分の日
	addNthWeekday(10, 1, 2); // スポーツの日
	add(11, 3); // 文化の日
	add(11, 23); // 勤労感謝の日

	const start = new Date(Date.UTC(year, 0, 1));
	const end = new Date(Date.UTC(year + 1, 0, 1));

	// Substitute holidays: a holiday on Sunday moves to the next non-holiday day.
	for (let d = new Date(start); d.getTime() < end.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
		if (d.getUTCDay() !== 0 || !holidays.has(isoDate(d))) continue;
		const substitute = new Date(d);
		substitute.setUTCDate(substitute.getUTCDate() + 1);
		while (holidays.has(isoDate(substitute))) substitute.setUTCDate(substitute.getUTCDate() + 1);
		holidays.add(isoDate(substitute));
	}

	// Citizen's holidays: a weekday sandwiched between two holidays.
	for (let d = new Date(start); d.getTime() < end.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
		if (d.getUTCDay() === 0 || d.getUTCDay() === 6 || holidays.has(isoDate(d))) continue;
		const previous = new Date(d);
		previous.setUTCDate(previous.getUTCDate() - 1);
		const next = new Date(d);
		next.setUTCDate(next.getUTCDate() + 1);
		if (holidays.has(isoDate(previous)) && holidays.has(isoDate(next))) holidays.add(isoDate(d));
	}

	return holidays;
}

export function isBusinessDay(date: Date, holidays: ReadonlySet<string>): boolean {
	const day = date.getUTCDay();
	if (day === 0 || day === 6) return false;
	return !holidays.has(isoDate(date));
}

export function businessDaysInMonth(period: UtcMonthPeriod, holidays: ReadonlySet<string>): number {
	let count = 0;
	for (let d = new Date(period.startMs); d.getTime() < period.endMs; d.setUTCDate(d.getUTCDate() + 1)) {
		if (isBusinessDay(d, holidays)) count++;
	}
	return count;
}

/** Business days from the start of the month through `now` inclusive. */
export function businessDaysElapsed(period: UtcMonthPeriod, now: Date, holidays: ReadonlySet<string>): number {
	let count = 0;
	for (
		let d = new Date(period.startMs);
		d.getTime() <= now.getTime() && d.getTime() < period.endMs;
		d.setUTCDate(d.getUTCDate() + 1)
	) {
		if (isBusinessDay(d, holidays)) count++;
	}
	return count;
}

export interface DailyCreditBudget {
	perDay: number;
	remainingCredits: number;
	remainingBusinessDays: number;
	totalBusinessDays: number;
	elapsedBusinessDays: number;
}

/** Credits available per remaining business day, or null when not computable. */
export function dailyCreditBudget(
	quota: CopilotQuota,
	period: UtcMonthPeriod,
	now: Date,
	holidays: ReadonlySet<string>,
): DailyCreditBudget | null {
	const premium = quota.categories.premium_interactions;
	if (!premium || premium.unlimited || premium.entitlement === null || premium.remaining === null) return null;
	const totalBusinessDays = businessDaysInMonth(period, holidays);
	const elapsedBusinessDays = businessDaysElapsed(period, now, holidays);
	const remainingBusinessDays = totalBusinessDays - elapsedBusinessDays;
	if (remainingBusinessDays <= 0) return null;
	const remainingCredits = Math.max(0, premium.remaining);
	return {
		perDay: remainingCredits / remainingBusinessDays,
		remainingCredits,
		remainingBusinessDays,
		totalBusinessDays,
		elapsedBusinessDays,
	};
}

export {
	aggregateSessionEntries,
	currentUtcMonth,
	isCopilotModel,
	isCopilotUsageDisabled,
	utcMonthPeriod,
};
export type { UsageTotals, UtcMonthPeriod };
