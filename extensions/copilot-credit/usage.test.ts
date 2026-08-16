import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	businessDaysElapsed,
	businessDaysInMonth,
	dailyCreditBudget,
	japaneseHolidays,
	parseCopilotQuota,
	utcMonthPeriod,
	type CopilotQuota,
} from "./usage.ts";

const EMPTY_HOLIDAYS = new Set<string>();

describe("parseCopilotQuota", () => {
	it("parses the modern quota_snapshots shape", () => {
		const payload = {
			login: "octocat",
			copilot_plan: "business",
			quota_reset_date_utc: "2026-08-01T00:00:00.000Z",
			quota_snapshots: {
				chat: { entitlement: 0, remaining: 0, percent_remaining: 100, unlimited: true },
				premium_interactions: {
					entitlement: 300,
					remaining: 93,
					percent_remaining: 31,
					unlimited: false,
					overage_count: 0,
					overage_permitted: true,
				},
			},
		};
		const parsed = parseCopilotQuota(payload);
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		assert.equal(parsed.value.login, "octocat");
		assert.equal(parsed.value.plan, "business");
		assert.equal(parsed.value.resetDateUtc, "2026-08-01T00:00:00.000Z");
		const premium = parsed.value.categories.premium_interactions;
		assert.deepEqual(premium, {
			entitlement: 300,
			remaining: 93,
			percentRemaining: 31,
			unlimited: false,
			overageCount: 0,
			overagePermitted: true,
		});
		assert.equal(parsed.value.categories.chat?.unlimited, true);
	});

	it("falls back to the legacy top-level shape", () => {
		const payload = {
			login: "octocat",
			plan: "pro",
			entitlement: 300,
			percent_remaining: 50.5,
			overage_count: 2,
		};
		const parsed = parseCopilotQuota(payload);
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		assert.equal(parsed.value.plan, "pro");
		assert.equal(parsed.value.categories.premium_interactions?.entitlement, 300);
		assert.equal(parsed.value.categories.premium_interactions?.percentRemaining, 50.5);
		assert.equal(parsed.value.categories.premium_interactions?.overageCount, 2);
		assert.equal(parsed.value.categories.premium_interactions?.remaining, null);
	});

	it("rejects a payload with no recognized quota fields", () => {
		assert.deepEqual(parseCopilotQuota({ login: "octocat" }), {
			ok: false,
			error: "quota response has no recognized quota fields",
		});
		assert.deepEqual(parseCopilotQuota(null), {
			ok: false,
			error: "quota response is not an object",
		});
		assert.deepEqual(parseCopilotQuota([1, 2]), {
			ok: false,
			error: "quota response is not an object",
		});
	});

	it("keeps an unlimited premium_interactions snapshot", () => {
		const payload = {
			quota_snapshots: {
				premium_interactions: { entitlement: 0, remaining: 0, percent_remaining: 100, unlimited: true },
			},
		};
		const parsed = parseCopilotQuota(payload);
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		assert.equal(parsed.value.categories.premium_interactions?.unlimited, true);
	});

	it("treats invalid numbers as absent while keeping valid fields", () => {
		const payload = {
			quota_snapshots: {
				premium_interactions: {
					entitlement: "nope",
					remaining: -1,
					percent_remaining: 31,
					unlimited: "yes",
				},
			},
		};
		const parsed = parseCopilotQuota(payload);
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		const premium = parsed.value.categories.premium_interactions;
		assert.equal(premium?.entitlement, null);
		assert.equal(premium?.remaining, null);
		assert.equal(premium?.unlimited, null);
		assert.equal(premium?.percentRemaining, 31);
	});
});

describe("Japanese business days and daily credit budget", () => {
	function quota(remaining: number): CopilotQuota {
		return {
			login: "octocat",
			plan: "pro",
			resetDateUtc: "2026-08-01T00:00:00.000Z",
			categories: {
				premium_interactions: {
					entitlement: 300,
					remaining,
					percentRemaining: 31,
					unlimited: false,
					overageCount: 0,
					overagePermitted: true,
				},
			},
		};
	}

	it("computes 2026 holidays including floating, equinox, substitute, and citizen's days", () => {
		const holidays = japaneseHolidays(2026);
		for (const date of [
			"2026-01-01",
			"2026-01-12", // 成人の日 (2nd Mon)
			"2026-02-11",
			"2026-02-23",
			"2026-03-20", // 春分の日
			"2026-04-29",
			"2026-05-03",
			"2026-05-04",
			"2026-05-05",
			"2026-05-06", // 振替休日 (May 3 is Sunday)
			"2026-07-20", // 海の日 (3rd Mon)
			"2026-08-11", // 山の日
			"2026-09-21", // 敬老の日 (3rd Mon)
			"2026-09-22", // 国民の休日 (between 敬老の日 and 秋分の日)
			"2026-09-23", // 秋分の日
			"2026-10-12", // スポーツの日 (2nd Mon)
			"2026-11-03",
			"2026-11-23",
		]) {
			assert.ok(holidays.has(date), `expected ${date} to be a holiday`);
		}
		assert.equal(holidays.has("2026-08-10"), false);
	});

	it("counts business days in a month excluding weekends and holidays", () => {
		const holidays = japaneseHolidays(2026);
		const august = utcMonthPeriod(2026, 8);
		// 31 days, 10 weekend days, 山の日 (Aug 11) → 20 business days
		assert.equal(businessDaysInMonth(august, holidays), 20);
	});

	it("counts elapsed business days through today inclusive", () => {
		const holidays = japaneseHolidays(2026);
		const august = utcMonthPeriod(2026, 8);
		const now = new Date(Date.UTC(2026, 7, 5)); // Wed Aug 5
		assert.equal(businessDaysElapsed(august, now, holidays), 3); // Aug 3, 4, 5
	});

	it("computes the per-remaining-business-day credit budget", () => {
		const holidays = japaneseHolidays(2026);
		const august = utcMonthPeriod(2026, 8);
		const now = new Date(Date.UTC(2026, 7, 5));
		const budget = dailyCreditBudget(quota(93), august, now, holidays);
		assert.ok(budget);
		assert.equal(budget?.remainingBusinessDays, 17);
		assert.equal(budget?.remainingCredits, 93);
		assert.ok(Math.abs((budget?.perDay ?? 0) - 93 / 17) < 1e-9);
	});

	it("returns null for unlimited quota or when no business days remain", () => {
		const holidays = japaneseHolidays(2026);
		const august = utcMonthPeriod(2026, 8);
		const now = new Date(Date.UTC(2026, 7, 5));
		const unlimited: CopilotQuota = {
			login: "octocat",
			plan: "pro",
			resetDateUtc: null,
			categories: {
				premium_interactions: {
					entitlement: 0,
					remaining: 0,
					percentRemaining: 100,
					unlimited: true,
					overageCount: 0,
					overagePermitted: false,
				},
			},
		};
		assert.equal(dailyCreditBudget(unlimited, august, now, holidays), null);
		// Aug 31 2026 is the last business day; today counted as elapsed → none left
		const lastDay = new Date(Date.UTC(2026, 7, 31));
		assert.equal(dailyCreditBudget(quota(93), august, lastDay, holidays), null);
	});
});

describe("utcMonthPeriod boundaries", () => {
	it("produces a December period whose end crosses into the next calendar year", () => {
		const dec = utcMonthPeriod(2026, 12);
		assert.equal(dec.year, 2026);
		assert.equal(dec.month, 12);
		assert.equal(dec.startMs, Date.UTC(2026, 11, 1));
		assert.equal(dec.endMs, Date.UTC(2027, 0, 1));
		assert.ok(dec.endMs - dec.startMs === 31 * 24 * 60 * 60 * 1000);
	});

	it("rejects out-of-range and non-integer year/month values", () => {
		assert.throws(() => utcMonthPeriod(2026, 0), RangeError);
		assert.throws(() => utcMonthPeriod(2026, 13), RangeError);
		assert.throws(() => utcMonthPeriod(2026, 1.5), RangeError);
		assert.throws(() => utcMonthPeriod(2026.5, 1), RangeError);
	});
});

describe("businessDaysInMonth and businessDaysElapsed edge cases", () => {
	it("counts only weekdays when the holiday set is empty", () => {
		// Feb 2026 (non-leap, 28 days, starts Sunday): 20 weekdays, 8 weekend days
		assert.equal(businessDaysInMonth(utcMonthPeriod(2026, 2), EMPTY_HOLIDAYS), 20);
		// Aug 2026 (31 days): 21 weekdays, 10 weekend days
		assert.equal(businessDaysInMonth(utcMonthPeriod(2026, 8), EMPTY_HOLIDAYS), 21);
	});

	it("handles leap-year February with empty holidays", () => {
		// Feb 2024 (leap year, 29 days, starts Thursday): 21 weekdays, 8 weekend days
		assert.equal(businessDaysInMonth(utcMonthPeriod(2024, 2), EMPTY_HOLIDAYS), 21);
		// The leap day itself is a Thursday (a business day) and must be counted.
		const leapDay = new Date(Date.UTC(2024, 1, 29));
		assert.equal(leapDay.getUTCDay(), 4);
		assert.equal(
			businessDaysElapsed(utcMonthPeriod(2024, 2), leapDay, EMPTY_HOLIDAYS),
			21,
		);
	});

	it("handles leap-year February with Japanese holidays", () => {
		// Feb 2024 with holidays: Feb 11 (Sun, 建国記念の日) → substitute Feb 12 (Mon),
		// Feb 23 (Fri, 天皇誕生日). Two weekday holidays reduce 21 → 19.
		const holidays = japaneseHolidays(2024);
		assert.ok(holidays.has("2024-02-11"));
		assert.ok(holidays.has("2024-02-12"));
		assert.ok(holidays.has("2024-02-23"));
		assert.equal(businessDaysInMonth(utcMonthPeriod(2024, 2), holidays), 19);
	});

	it("returns 0 elapsed when now is before the month starts", () => {
		const august = utcMonthPeriod(2026, 8);
		const before = new Date(Date.UTC(2026, 6, 31)); // Jul 31 2026
		assert.equal(businessDaysElapsed(august, before, EMPTY_HOLIDAYS), 0);
		assert.equal(businessDaysElapsed(august, before, japaneseHolidays(2026)), 0);
	});

	it("counts nothing when the first day of the month is a weekend", () => {
		// Aug 1 2026 is a Saturday; elapsed through it inclusive is 0.
		const august = utcMonthPeriod(2026, 8);
		const first = new Date(Date.UTC(2026, 7, 1));
		assert.equal(first.getUTCDay(), 6);
		assert.equal(businessDaysElapsed(august, first, EMPTY_HOLIDAYS), 0);
	});

	it("counts exactly one business day when now is the first business day", () => {
		// Aug 3 2026 is the first Monday → 1 business day elapsed.
		const august = utcMonthPeriod(2026, 8);
		const firstMonday = new Date(Date.UTC(2026, 7, 3));
		assert.equal(firstMonday.getUTCDay(), 1);
		assert.equal(businessDaysElapsed(august, firstMonday, EMPTY_HOLIDAYS), 1);
	});

	it("skips a mid-month holiday when counting elapsed days", () => {
		// Aug 11 2026 (山の日, Tuesday) is a holiday. Through Aug 11 inclusive the
		// business days are Aug 3,4,5,6,7,10 = 6.
		const holidays = japaneseHolidays(2026);
		const august = utcMonthPeriod(2026, 8);
		const now = new Date(Date.UTC(2026, 7, 11));
		assert.equal(now.getUTCDay(), 2);
		assert.equal(businessDaysElapsed(august, now, holidays), 6);
	});

	it("counts the entire month when now lands exactly on the end boundary", () => {
		// now == endMs (Sep 1 2026 00:00 UTC). The loop runs for d < endMs, so the
		// full month is counted; the next-month day itself is excluded.
		const holidays = japaneseHolidays(2026);
		const august = utcMonthPeriod(2026, 8);
		const endBoundary = new Date(august.endMs);
		assert.equal(businessDaysElapsed(august, endBoundary, holidays), businessDaysInMonth(august, holidays));
	});
});

describe("dailyCreditBudget boundary inputs", () => {
	function quota(overrides: Partial<{ entitlement: number | null; remaining: number | null; unlimited: boolean | null }>): CopilotQuota {
		return {
			login: "octocat",
			plan: "pro",
			resetDateUtc: "2026-08-01T00:00:00.000Z",
			categories: {
				premium_interactions: {
					entitlement: overrides.entitlement === undefined ? 300 : overrides.entitlement,
					remaining: overrides.remaining === undefined ? 93 : overrides.remaining,
					percentRemaining: 31,
					unlimited: overrides.unlimited === undefined ? false : overrides.unlimited,
					overageCount: 0,
					overagePermitted: true,
				},
			},
		};
	}

	it("returns a budget with zero per-day when remaining credits are zero", () => {
		const holidays = japaneseHolidays(2026);
		const august = utcMonthPeriod(2026, 8);
		const now = new Date(Date.UTC(2026, 7, 5));
		const budget = dailyCreditBudget(quota({ remaining: 0 }), august, now, holidays);
		assert.ok(budget);
		assert.equal(budget?.remainingCredits, 0);
		assert.equal(budget?.perDay, 0);
		assert.equal(budget?.remainingBusinessDays, 17);
	});

	it("returns null when remaining is null even with a valid entitlement", () => {
		const holidays = japaneseHolidays(2026);
		const august = utcMonthPeriod(2026, 8);
		const now = new Date(Date.UTC(2026, 7, 5));
		assert.equal(dailyCreditBudget(quota({ remaining: null }), august, now, holidays), null);
		assert.equal(dailyCreditBudget(quota({ entitlement: null }), august, now, holidays), null);
	});

	it("returns null when now is past the last business day of the month", () => {
		const holidays = japaneseHolidays(2026);
		const august = utcMonthPeriod(2026, 8);
		const afterMonth = new Date(Date.UTC(2026, 8, 1)); // Sep 1
		assert.equal(dailyCreditBudget(quota({}), august, afterMonth, holidays), null);
	});
});

describe("parseCopilotQuota additional boundary cases", () => {
	it("rejects an empty quota_snapshots object", () => {
		const parsed = parseCopilotQuota({ quota_snapshots: {} });
		assert.deepEqual(parsed, { ok: false, error: "quota response has no recognized quota fields" });
	});

	it("accepts a payload whose only category is chat (no premium_interactions)", () => {
		const parsed = parseCopilotQuota({
			quota_snapshots: { chat: { entitlement: 100, remaining: 50, percent_remaining: 50 } },
		});
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		assert.equal(parsed.value.categories.premium_interactions, undefined);
		assert.equal(parsed.value.categories.chat?.remaining, 50);
	});

	it("prefers camelCase quota fields over snake_case when both are absent, and parses camelCase shapes", () => {
		const parsed = parseCopilotQuota({
			quota_snapshots: {
				premium_interactions: {
					entitlement: 300,
					remaining: 10,
					percentRemaining: 3.3,
					overageCount: 4,
					overagePermitted: false,
					unlimited: false,
				},
			},
		});
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		const premium = parsed.value.categories.premium_interactions;
		assert.deepEqual(premium, {
			entitlement: 300,
			remaining: 10,
			percentRemaining: 3.3,
			unlimited: false,
			overageCount: 4,
			overagePermitted: false,
		});
	});

	it("treats non-boolean overagePermitted/unlimited as null", () => {
		const parsed = parseCopilotQuota({
			quota_snapshots: {
				premium_interactions: {
					entitlement: 300,
					remaining: 10,
					overagePermitted: "yes",
					unlimited: 1,
				},
			},
		});
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		const premium = parsed.value.categories.premium_interactions;
		assert.equal(premium?.unlimited, null);
		assert.equal(premium?.overagePermitted, null);
	});

	it("keeps a category that carries only unlimited:false (no numeric fields)", () => {
		const parsed = parseCopilotQuota({
			quota_snapshots: { premium_interactions: { unlimited: false } },
		});
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		const premium = parsed.value.categories.premium_interactions;
		assert.equal(premium?.unlimited, false);
		assert.equal(premium?.entitlement, null);
		assert.equal(premium?.remaining, null);
	});
});
