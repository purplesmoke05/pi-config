import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	estimateProviderPayload,
	estimateTextTokens,
	parseOfficialBillingReport,
} from "./usage.ts";

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

describe("official billing parsing", () => {
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
