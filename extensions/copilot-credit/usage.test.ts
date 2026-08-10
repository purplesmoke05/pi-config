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
