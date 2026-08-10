import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	perDaySegment,
	planSegment,
	quotaPerDayLine,
	quotaReportLines,
	sessionSegment,
} from "./display.ts";
import {
	japaneseHolidays,
	utcMonthPeriod,
	type CopilotQuota,
	type UsageTotals,
} from "./usage.ts";

describe("Copilot monthly quota display", () => {
	function quota(category: Partial<CopilotQuota["categories"]["premium_interactions"]>): CopilotQuota {
		return {
			login: "octocat",
			plan: "pro",
			resetDateUtc: "2026-08-01T00:00:00.000Z",
			categories: {
				premium_interactions: {
					entitlement: null,
					remaining: null,
					percentRemaining: null,
					unlimited: null,
					overageCount: null,
					overagePermitted: null,
					...category,
				},
			},
		};
	}

	it("renders detailed report lines for a metered plan", () => {
		const lines = quotaReportLines(quota({ entitlement: 300, remaining: 93, percentRemaining: 31 }));
		assert.deepEqual(lines, [
			"  premium requests: 207 used / 300 limit · 31% remaining",
			"  plan: pro",
			"  reset: 2026-08-01 UTC",
		]);
	});

	it("reports overage and permitted state", () => {
		const lines = quotaReportLines(
			quota({ entitlement: 300, remaining: -7, overageCount: 7, overagePermitted: true }),
		);
		assert.ok(lines.some((line) => line.includes("overage: +7 (permitted)")));
	});

	it("marks unlimited plans and missing quota", () => {
		assert.deepEqual(
			quotaReportLines(quota({ unlimited: true, entitlement: 0, remaining: 0 })),
			["  premium requests: unlimited", "  plan: pro", "  reset: 2026-08-01 UTC"],
		);
		assert.deepEqual(quotaReportLines(undefined), ["  not requested · run /copilot-credit"]);
	});
});

describe("Copilot per-day credit budget display", () => {
	const holidays = japaneseHolidays(2026);
	const period = utcMonthPeriod(2026, 8);
	const now = new Date(Date.UTC(2026, 7, 5)); // Wed Aug 5, 2026

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

	it("renders the compact per-day segment and the detailed report line", () => {
		assert.equal(perDaySegment(quota(93), period, now, holidays), "5.5 AIC/day");
		assert.equal(
			quotaPerDayLine(quota(93), period, now, holidays),
			"  per remaining business day: 5.5 cr (93 cr / 17 business days)",
		);
	});

	it("returns null when no business days remain", () => {
		const lastDay = new Date(Date.UTC(2026, 7, 31)); // last business day of Aug 2026
		assert.equal(perDaySegment(quota(93), period, lastDay, holidays), null);
		assert.equal(quotaPerDayLine(quota(93), period, lastDay, holidays), null);
	});
});

describe("Copilot CLI-style credit status", () => {
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
	const totals: UsageTotals = {
		calls: 1,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		grossCredits: 2.1234,
		creditsComplete: true,
	};

	it("renders the plan meter with used/limit and percent used", () => {
		assert.equal(planSegment(quota(93)), "Plan: 207/300 (69% used)");
		assert.equal(planSegment(quota(0)), "Plan: 300/300 (100% used)");
		assert.equal(planSegment(undefined), null);
	});

	it("renders the session meter in AIC with an incomplete marker", () => {
		assert.equal(sessionSegment(totals), "Session: 2.12 AIC used");
		assert.equal(sessionSegment({ ...totals, creditsComplete: false }), "Session: 2.12 AIC used +?");
	});
});
