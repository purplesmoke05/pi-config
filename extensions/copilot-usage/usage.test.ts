import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	aggregateHistory,
	aggregateSessionEntries,
	businessDaysElapsed,
	businessDaysInMonth,
	dailyCreditBudget,
	estimateProviderPayload,
	estimateTextTokens,
	isCopilotModel,
	isCopilotUsageDisabled,
	japaneseHolidays,
	parseCopilotQuota,
	parseOfficialBillingReport,
	parseSessionJsonl,
	parseUtcMonth,
	utcMonthPeriod,
	type CopilotQuota,
} from "./usage.ts";

interface MessageOptions {
	model?: string;
	timestamp?: number;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	costTotal?: number;
	provider?: string;
}

function assistantMessage(options: MessageOptions = {}) {
	return {
		role: "assistant",
		provider: options.provider ?? "github-copilot",
		model: options.model ?? "gpt-5-mini",
		timestamp: options.timestamp ?? Date.UTC(2026, 6, 1),
		content: [{ type: "text", text: "done" }],
		usage: {
			input: options.input ?? 0,
			output: options.output ?? 0,
			cacheRead: options.cacheRead ?? 0,
			cacheWrite: options.cacheWrite ?? 0,
			totalTokens:
				(options.input ?? 0) + (options.output ?? 0) + (options.cacheRead ?? 0) + (options.cacheWrite ?? 0),
			cost: { total: options.costTotal ?? 0 },
		},
	};
}

function messageEntry(id: string, message: ReturnType<typeof assistantMessage>) {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(message.timestamp).toISOString(),
		message,
	};
}

describe("provider activation", () => {
	it("matches only the exact GitHub Copilot provider id", () => {
		assert.equal(isCopilotModel({ provider: "github-copilot" }), true);
		assert.equal(isCopilotModel({ provider: "github" }), false);
		assert.equal(isCopilotModel({ provider: "github-copilot-proxy" }), false);
		assert.equal(isCopilotModel(undefined), false);
	});

	it("recognizes the documented opt-out values", () => {
		assert.equal(isCopilotUsageDisabled({ PI_COPILOT_USAGE_DISABLE: "YES" }), true);
		assert.equal(isCopilotUsageDisabled({ PI_COPILOT_USAGE_DISABLE: "0" }), false);
	});
});

describe("outgoing payload estimate", () => {
	it("estimates model-facing text in token units without JSON framing", () => {
		assert.equal(estimateTextTokens("a".repeat(8)), 2);
		assert.equal(estimateTextTokens("あ".repeat(4)), 8);
		assert.equal(estimateTextTokens("a".repeat(4) + "あ"), 3);
	});

	it("counts provider input fields without counting base64 image bytes as text", () => {
		const estimate = estimateProviderPayload({
			system: "system prompt",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "hello" },
						{
							type: "image",
							source: { type: "base64", media_type: "image/png", data: "A".repeat(20_000) },
						},
					],
				},
			],
			max_tokens: 100_000,
		});

		assert.equal(estimate.ok, true);
		assert.equal(estimate.images, 1);
		assert.ok(estimate.textCharacters < 1_000);
		assert.ok((estimate.tokens ?? 0) >= 1_200);
		assert.ok((estimate.tokens ?? 0) < 1_500);
	});

	it("reports unsupported payloads instead of silently returning zero", () => {
		assert.deepEqual(estimateProviderPayload({ model: "gpt-5.4", max_tokens: 10 }), {
			ok: false,
			tokens: null,
			textCharacters: 0,
			images: 0,
			error: "no recognized input fields in provider payload",
		});
	});

	it("uses a conservative non-ASCII estimate and Pi context floor", () => {
		const japanese = estimateProviderPayload({ messages: [{ role: "user", content: "あ".repeat(4_000) }] });
		assert.equal(japanese.ok, true);
		assert.ok((japanese.tokens ?? 0) >= 8_000);

		const floored = estimateProviderPayload({ messages: [{ role: "user", content: "short" }] }, 12_345);
		assert.equal(floored.tokens, 12_345);
	});
});

describe("provider-reported usage and gross credit estimate", () => {
	it("uses Pi's recorded standard-rate cost", () => {
		const aggregate = aggregateSessionEntries([
			messageEntry(
				"standard",
				assistantMessage({ input: 100_000, cacheRead: 50_000, output: 10_000, costTotal: 0.04625 }),
			),
		]);

		assert.equal(aggregate.calls, 1);
		assert.equal(aggregate.totalTokens, 160_000);
		assert.equal(aggregate.grossCredits, 4.625);
		assert.equal(aggregate.creditsComplete, true);
	});

	it("applies the whole-request GPT-5.4 long-context tier above 272k input", () => {
		const aggregate = aggregateSessionEntries([
			messageEntry(
				"long",
				assistantMessage({
					model: "gpt-5.4",
					input: 272_001,
					output: 1_000,
					costTotal: 0.6950025,
				}),
			),
		]);

		assert.ok(Math.abs(aggregate.grossCredits - 138.2505) < 1e-9);
	});

	it("keeps the standard tier at exactly 272k prompt tokens", () => {
		const aggregate = aggregateSessionEntries([
			messageEntry(
				"threshold",
				assistantMessage({ model: "gpt-5.4", input: 272_000, output: 1_000, costTotal: 0.695 }),
			),
		]);

		assert.equal(aggregate.grossCredits, 69.5);
	});

	it("includes cached input when choosing a long-context tier", () => {
		const aggregate = aggregateSessionEntries([
			messageEntry(
				"cached-long",
				assistantMessage({ model: "gpt-5.4", input: 200_000, cacheRead: 72_001, costTotal: 0 }),
			),
		]);

		assert.ok(Math.abs(aggregate.grossCredits - 103.60005) < 1e-9);
	});

	it("excludes non-Copilot assistant messages", () => {
		const aggregate = aggregateSessionEntries([
			messageEntry("other", assistantMessage({ provider: "openai", input: 1_000, costTotal: 1 })),
		]);
		assert.equal(aggregate.calls, 0);
	});

	it("does not present positive usage with zero recorded cost as free", () => {
		const aggregate = aggregateSessionEntries([
			messageEntry("unpriced", assistantMessage({ input: 100, costTotal: 0 })),
		]);
		assert.equal(aggregate.grossCredits, 0);
		assert.equal(aggregate.creditsComplete, false);
		assert.match(aggregate.warnings.join("\n"), /zero recorded cost/);
	});

	it("marks Pi internal summarizer calls as unpriced instead of dropping them", () => {
		const aggregate = aggregateSessionEntries([
			messageEntry("priced", assistantMessage({ input: 100, costTotal: 0.001 })),
			{
				type: "compaction",
				id: "compact-1",
				parentId: "priced",
				timestamp: "2026-07-02T00:00:00.000Z",
				summary: "summary",
				tokensBefore: 100,
				firstKeptEntryId: "priced",
			},
			{
				type: "branch_summary",
				id: "hook-summary",
				parentId: "priced",
				timestamp: "2026-07-02T00:00:00.000Z",
				summary: "extension-provided",
				fromId: "priced",
				fromHook: true,
			},
		]);

		assert.equal(aggregate.unattributedInternalCalls, 1);
		assert.equal(aggregate.creditsComplete, false);
		assert.match(aggregate.warnings.join("\n"), /did not persist provider\/usage/);
	});
});

describe("monthly history", () => {
	it("uses UTC boundaries and removes fork-copied assistant entries", () => {
		const julyMessage = assistantMessage({
			timestamp: Date.UTC(2026, 6, 1, 0, 0, 0, 0),
			input: 100,
			output: 20,
			costTotal: 0.01,
		});
		const copiedEntry = messageEntry("copied-id", julyMessage);
		const rewrittenCopy = {
			...structuredClone(copiedEntry),
			parentId: "rewritten-parent",
			timestamp: "2026-07-02T00:00:00.000Z",
		};
		const juneEntry = messageEntry(
			"june-id",
			assistantMessage({ timestamp: Date.UTC(2026, 5, 30, 23, 59, 59, 999), input: 900, costTotal: 1 }),
		);
		const aggregate = aggregateHistory(
			[
				{ path: "source.jsonl", entries: [copiedEntry, juneEntry] },
				{ path: "fork.jsonl", entries: [rewrittenCopy] },
			],
			utcMonthPeriod(2026, 7),
		);

		assert.equal(aggregate.calls, 1);
		assert.equal(aggregate.input, 100);
		assert.equal(aggregate.output, 20);
		assert.equal(aggregate.duplicatesRemoved, 1);
		assert.equal(aggregate.filesScanned, 2);
	});

	it("parses explicit UTC months strictly", () => {
		assert.equal(parseUtcMonth("2026-07")?.startMs, Date.UTC(2026, 6, 1));
		assert.equal(parseUtcMonth("2026-13"), null);
		assert.equal(parseUtcMonth("July"), null);
	});

	it("deduplicates fork-copied internal summary entries while preserving the incomplete flag", () => {
		const summary = {
			type: "branch_summary",
			id: "summary-1",
			parentId: "original-parent",
			timestamp: "2026-07-03T00:00:00.000Z",
			fromId: "old-leaf",
			summary: "branch summary",
		};
		const copy = { ...summary, parentId: "rewritten-parent" };
		const aggregate = aggregateHistory(
			[
				{ path: "source.jsonl", entries: [summary] },
				{ path: "fork.jsonl", entries: [copy] },
			],
			utcMonthPeriod(2026, 7),
		);

		assert.equal(aggregate.unattributedInternalCalls, 1);
		assert.equal(aggregate.duplicatesRemoved, 1);
		assert.equal(aggregate.creditsComplete, false);
	});
});

describe("session and official billing parsing", () => {
	it("keeps valid JSONL entries and reports malformed lines", () => {
		const parsed = parseSessionJsonl('{"type":"session"}\nnot-json\n{"type":"message"}\n', "x.jsonl");
		assert.equal(parsed.entries.length, 2);
		assert.deepEqual(parsed.errors, ["x.jsonl: invalid JSON on line 2"]);
	});

	it("sums official gross, discount, and net credits separately", () => {
		const parsed = parseOfficialBillingReport({
			timePeriod: { year: 2026, month: 7 },
			usageItems: [
				{
					unitType: "ai-credits",
					grossQuantity: 100,
					discountQuantity: 40,
					netQuantity: 60,
					grossAmount: 1,
					discountAmount: 0.4,
					netAmount: 0.6,
				},
				{
					unitType: "ai-credits",
					grossQuantity: 50,
					discountQuantity: 50,
					netQuantity: 0,
					grossAmount: 0.5,
					discountAmount: 0.5,
					netAmount: 0,
				},
			],
		});

		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		assert.deepEqual(parsed.value.totals, {
			grossCredits: 150,
			discountCredits: 90,
			netCredits: 60,
			grossUsd: 1.5,
			discountUsd: 0.9,
			netUsd: 0.6,
		});
		assert.deepEqual(parsed.value.warnings, []);
	});

	it("rejects an incomplete billing schema", () => {
		assert.deepEqual(parseOfficialBillingReport({ usageItems: [{}] }), {
			ok: false,
			error: "usageItems[0] has missing or invalid totals",
		});
	});
});

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
