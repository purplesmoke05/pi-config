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

describe("Copilot display boundary cases", () => {
	const holidays = japaneseHolidays(2026);
	const period = utcMonthPeriod(2026, 8);
	const now = new Date(Date.UTC(2026, 7, 5)); // Wed Aug 5, 2026

	function quota(
		category: Partial<CopilotQuota["categories"]["premium_interactions"]>,
	): CopilotQuota {
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

	const emptyCategoryQuota: CopilotQuota = {
		login: "octocat",
		plan: "pro",
		resetDateUtc: "2026-08-01T00:00:00.000Z",
		categories: {},
	};

	describe("planSegment", () => {
		it("returns null for null, undefined, and missing premium category", () => {
			assert.equal(planSegment(null), null);
			assert.equal(planSegment(undefined), null);
			assert.equal(planSegment(emptyCategoryQuota), null);
		});

		it("returns null for unlimited plans and null entitlement/remaining", () => {
			assert.equal(planSegment(quota({ unlimited: true, entitlement: 300, remaining: 93 })), null);
			assert.equal(planSegment(quota({ entitlement: null, remaining: 93 })), null);
			assert.equal(planSegment(quota({ entitlement: 300, remaining: null })), null);
		});

		it("clamps negative used (overage) and computes percent over 100", () => {
			// remaining below zero means consumed past the entitlement
			assert.equal(planSegment(quota({ entitlement: 300, remaining: -7 })), "Plan: 307/300 (102% used)");
		});

		it("clamps used to zero when remaining exceeds entitlement", () => {
			assert.equal(planSegment(quota({ entitlement: 300, remaining: 400 })), "Plan: 0/300 (0% used)");
		});

		it("documents the zero-entitlement division behavior", () => {
			// entitlement 0 with remaining 0 yields 0/0 -> NaN percent (current behavior)
			assert.equal(planSegment(quota({ entitlement: 0, remaining: 0 })), "Plan: 0/0 (NaN% used)");
		});
	});

	describe("sessionSegment", () => {
		const base: UsageTotals = {
			calls: 0,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			grossCredits: 0,
			creditsComplete: true,
		};

		it("renders zero credits as 0.00 AIC", () => {
			assert.equal(sessionSegment(base), "Session: 0.00 AIC used");
			assert.equal(sessionSegment({ ...base, creditsComplete: false }), "Session: 0.00 AIC used +?");
		});
	});

	describe("perDaySegment and quotaPerDayLine", () => {
		it("returns null when the premium category is missing entirely", () => {
			assert.equal(perDaySegment(emptyCategoryQuota, period, now, holidays), null);
			assert.equal(quotaPerDayLine(emptyCategoryQuota, period, now, holidays), null);
		});

		it("returns null for unlimited plans and null entitlement/remaining", () => {
			assert.equal(perDaySegment(quota({ unlimited: true, entitlement: 300, remaining: 93 }), period, now, holidays), null);
			assert.equal(quotaPerDayLine(quota({ unlimited: true, entitlement: 300, remaining: 93 }), period, now, holidays), null);
			assert.equal(perDaySegment(quota({ entitlement: null, remaining: 93 }), period, now, holidays), null);
			assert.equal(quotaPerDayLine(quota({ entitlement: 300, remaining: null }), period, now, holidays), null);
		});

		it("renders zero remaining credits as 0.0 per business day (no division by zero)", () => {
			assert.equal(perDaySegment(quota({ entitlement: 300, remaining: 0 }), period, now, holidays), "0.0 AIC/day");
			assert.equal(
				quotaPerDayLine(quota({ entitlement: 300, remaining: 0 }), period, now, holidays),
				"  per remaining business day: 0.0 cr (0 cr / 17 business days)",
			);
		});

		it("returns null when no business days remain even with credits left", () => {
			const lastDay = new Date(Date.UTC(2026, 7, 31)); // last business day of Aug 2026
			assert.equal(perDaySegment(quota({ entitlement: 300, remaining: 93 }), period, lastDay, holidays), null);
			assert.equal(quotaPerDayLine(quota({ entitlement: 300, remaining: 93 }), period, lastDay, holidays), null);
		});
	});

	describe("quotaReportLines", () => {
		it("reports missing premium category for an otherwise-empty quota", () => {
			assert.deepEqual(quotaReportLines(emptyCategoryQuota), [
				"  no premium-request quota reported for this account",
			]);
		});

		it("only shows remaining when entitlement is null", () => {
			assert.deepEqual(
				quotaReportLines(quota({ entitlement: null, remaining: 93, percentRemaining: null })),
				["  premium requests: 93 remaining", "  plan: pro", "  reset: 2026-08-01 UTC"],
			);
		});

		it("only shows percentRemaining when entitlement and remaining are null", () => {
			assert.deepEqual(
				quotaReportLines(quota({ entitlement: null, remaining: null, percentRemaining: 31 })),
				["  premium requests: 31% remaining", "  plan: pro", "  reset: 2026-08-01 UTC"],
			);
		});

		it("clamps consumed to the entitlement and shows overage line", () => {
			const lines = quotaReportLines(
				quota({ entitlement: 300, remaining: -7, overageCount: 7, overagePermitted: false }),
			);
			assert.ok(lines.some((l) => l.includes("premium requests: 300 used / 300 limit")));
			assert.ok(lines.some((l) => l.includes("overage: +7")));
			assert.ok(!lines.some((l) => l.includes("permitted")));
		});

		it("omits overage line when overageCount is zero or null", () => {
			const lines = quotaReportLines(
				quota({ entitlement: 300, remaining: 93, overageCount: 0, overagePermitted: true }),
			);
			assert.ok(!lines.some((l) => l.includes("overage")));
		});
	});
});
