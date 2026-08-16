import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	codexUsageReportLines,
	formatCodexStatus,
	formatDuration,
	parseCodexUsage,
	remainingPercent,
} from "./usage.ts";

const PAYLOAD = {
	plan_type: "pro",
	rate_limit: {
		allowed: true,
		limit_reached: false,
		primary_window: {
			used_percent: 86,
			limit_window_seconds: 604_800,
			reset_after_seconds: 325_000,
			reset_at: 1_787_219_466,
		},
		secondary_window: null,
	},
	additional_rate_limits: [
		{
			limit_name: "GPT-5.3-Codex-Spark",
			rate_limit: {
				allowed: true,
				limit_reached: false,
				primary_window: {
					used_percent: 0,
					limit_window_seconds: 604_800,
					reset_after_seconds: 604_800,
					reset_at: 1_787_499_267,
				},
				secondary_window: null,
			},
		},
	],
	credits: {
		has_credits: false,
		unlimited: false,
		balance: "0",
	},
};

describe("Codex usage parsing", () => {
	it("keeps only quota fields and parses additional limits", () => {
		const parsed = parseCodexUsage({
			...PAYLOAD,
			email: "not-retained@example.com",
			account_id: "secret",
		});
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		assert.equal(parsed.value.planType, "pro");
		assert.equal(parsed.value.rateLimit.primaryWindow.usedPercent, 86);
		assert.equal(
			parsed.value.additionalRateLimits[0]?.name,
			"GPT-5.3-Codex-Spark",
		);
		assert.equal("email" in parsed.value, false);
		assert.equal("accountId" in parsed.value, false);
	});

	it("rejects a response without a complete primary window", () => {
		const parsed = parseCodexUsage({
			rate_limit: { allowed: true, primary_window: {} },
		});
		assert.deepEqual(parsed, {
			ok: false,
			error: "missing or invalid rate_limit",
		});
	});
});

describe("Codex usage display", () => {
	it("renders a compact weekly footer status", () => {
		const parsed = parseCodexUsage(PAYLOAD);
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		assert.equal(
			formatCodexStatus(parsed.value),
			"Codex wk 14% left · reset 3d18h",
		);
		assert.equal(remainingPercent(parsed.value.rateLimit.primaryWindow), 14);
	});

	it("renders both five-hour and weekly windows when both exist", () => {
		const parsed = parseCodexUsage({
			...PAYLOAD,
			rate_limit: {
				...PAYLOAD.rate_limit,
				primary_window: {
					...PAYLOAD.rate_limit.primary_window,
					limit_window_seconds: 18_000,
					used_percent: 25,
				},
				secondary_window: PAYLOAD.rate_limit.primary_window,
			},
		});
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		assert.equal(formatCodexStatus(parsed.value), "Codex 5h 75% · wk 14% left");
	});

	it("formats the detailed report without account-identifying fields", () => {
		const parsed = parseCodexUsage(PAYLOAD);
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		const report = codexUsageReportLines(parsed.value).join("\n");
		assert.match(report, /plan: pro/);
		assert.match(report, /main wk: 86% used \/ 14% remaining/);
		assert.match(report, /GPT-5\.3-Codex-Spark wk: 0% used \/ 100% remaining/);
		assert.match(report, /credits: none/);
		assert.doesNotMatch(report, /email|account/i);
	});

	it("formats reset durations compactly", () => {
		assert.equal(formatDuration(325_000), "3d18h");
		assert.equal(formatDuration(7_260), "2h1m");
		assert.equal(formatDuration(59), "0m");
	});
});
