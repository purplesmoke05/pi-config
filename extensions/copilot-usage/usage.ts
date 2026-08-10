/**
 * copilot-usage — outgoing payload estimation and official GitHub billing
 * parsing. Session aggregation, provider activation, and UTC month helpers
 * live in the shared `copilot-shared` module so `copilot-credit` can reuse
 * them without depending on this extension.
 */

import {
	finiteNonNegativeInteger,
	finiteNonNegativeNumber,
	isRecord,
} from "../copilot-shared/usage.ts";

export const PRICING_SNAPSHOT_DATE = "2026-07-11";
export const PRICING_SOURCE =
	"https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing";

const CHARS_PER_TOKEN = 4;
const TOKENS_PER_NON_ASCII_CODE_POINT = 2;
const TOKENS_PER_IMAGE = 1_200;
const INPUT_PAYLOAD_KEYS = [
	"system",
	"messages",
	"input",
	"instructions",
	"prompt",
	"tools",
	"functions",
	"response_format",
] as const;

export interface PayloadEstimate {
	ok: boolean;
	tokens: number | null;
	textCharacters: number;
	images: number;
	error?: string;
}

export interface OfficialBillingTotals {
	grossCredits: number;
	discountCredits: number;
	netCredits: number;
	grossUsd: number;
	discountUsd: number;
	netUsd: number;
}

export interface OfficialBillingSummary {
	totals: OfficialBillingTotals;
	items: number;
	year: number | null;
	month: number | null;
	warnings: string[];
}

export type OfficialBillingParseResult =
	| { ok: true; value: OfficialBillingSummary }
	| { ok: false; error: string };

function looksLikeImageDataUrl(value: string): boolean {
	return /^data:image\/[a-z0-9.+-]+;base64,/i.test(value);
}

function sanitizePayloadValue(
	value: unknown,
	seen: WeakSet<object>,
	state: { images: number },
): unknown {
	if (typeof value === "string") {
		if (looksLikeImageDataUrl(value)) {
			state.images++;
			return "data:image/<omitted>";
		}
		return value;
	}
	if (value === null || typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "bigint") throw new TypeError("BigInt is not supported in provider payloads");
	if (typeof value !== "object") return undefined;
	if (seen.has(value)) throw new TypeError("circular provider payload");
	seen.add(value);

	try {
		if (Array.isArray(value)) {
			return value.map((item) => sanitizePayloadValue(item, seen, state));
		}

		const record = value as Record<string, unknown>;
		const clone: Record<string, unknown> = {};
		const recordType = typeof record.type === "string" ? record.type.toLowerCase() : "";
		const mediaType =
			typeof record.media_type === "string"
				? record.media_type
				: typeof record.mimeType === "string"
					? record.mimeType
					: "";
		const hasRawImageData =
			typeof record.data === "string" &&
			(mediaType.startsWith("image/") || recordType === "image" || recordType === "base64");

		for (const [key, child] of Object.entries(record)) {
			if (key === "data" && hasRawImageData) {
				state.images++;
				clone[key] = "<image omitted>";
				continue;
			}
			clone[key] = sanitizePayloadValue(child, seen, state);
		}
		return clone;
	} finally {
		seen.delete(value);
	}
}

export function estimateTextTokens(text: string): number {
	let asciiCharacters = 0;
	let nonAsciiCodePoints = 0;
	for (const character of text) {
		if ((character.codePointAt(0) ?? 0) <= 0x7f) asciiCharacters++;
		else nonAsciiCodePoints++;
	}
	return Math.ceil(
		asciiCharacters / CHARS_PER_TOKEN + nonAsciiCodePoints * TOKENS_PER_NON_ASCII_CODE_POINT,
	);
}

export function estimateProviderPayload(
	payload: unknown,
	contextTokenFloor?: number | null,
): PayloadEstimate {
	if (!isRecord(payload)) {
		return { ok: false, tokens: null, textCharacters: 0, images: 0, error: "payload is not an object" };
	}

	const inputPayload: Record<string, unknown> = {};
	for (const key of INPUT_PAYLOAD_KEYS) {
		if (key in payload) inputPayload[key] = payload[key];
	}
	if (Object.keys(inputPayload).length === 0) {
		return {
			ok: false,
			tokens: null,
			textCharacters: 0,
			images: 0,
			error: "no recognized input fields in provider payload",
		};
	}

	const state = { images: 0 };
	try {
		const sanitized = sanitizePayloadValue(inputPayload, new WeakSet<object>(), state);
		const serialized = JSON.stringify(sanitized);
		if (serialized === undefined) throw new TypeError("provider payload could not be serialized");
		const textCharacters = serialized.length;
		const payloadTokens = estimateTextTokens(serialized) + state.images * TOKENS_PER_IMAGE;
		const contextFloor =
			typeof contextTokenFloor === "number" && Number.isFinite(contextTokenFloor) && contextTokenFloor >= 0
				? Math.ceil(contextTokenFloor)
				: 0;
		return {
			ok: true,
			tokens: Math.max(payloadTokens, contextFloor),
			textCharacters,
			images: state.images,
		};
	} catch (error) {
		return {
			ok: false,
			tokens: null,
			textCharacters: 0,
			images: state.images,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function pickField(record: Record<string, unknown>, camel: string, snake: string): unknown {
	return record[camel] ?? record[snake];
}

function requiredBillingNumber(record: Record<string, unknown>, camel: string, snake: string): number | null {
	return finiteNonNegativeNumber(pickField(record, camel, snake));
}

function nearlyEqual(left: number, right: number): boolean {
	return Math.abs(left - right) <= Math.max(1e-9, Math.abs(left) * 1e-9, Math.abs(right) * 1e-9);
}

export function parseOfficialBillingReport(payload: unknown): OfficialBillingParseResult {
	if (!isRecord(payload)) return { ok: false, error: "billing response is not an object" };
	const itemsValue = pickField(payload, "usageItems", "usage_items");
	if (!Array.isArray(itemsValue)) return { ok: false, error: "billing response has no usageItems array" };

	const totals: OfficialBillingTotals = {
		grossCredits: 0,
		discountCredits: 0,
		netCredits: 0,
		grossUsd: 0,
		discountUsd: 0,
		netUsd: 0,
	};
	const warnings = new Set<string>();

	for (let index = 0; index < itemsValue.length; index++) {
		const item = itemsValue[index];
		if (!isRecord(item)) return { ok: false, error: `usageItems[${index}] is not an object` };
		const values = {
			grossCredits: requiredBillingNumber(item, "grossQuantity", "gross_quantity"),
			discountCredits: requiredBillingNumber(item, "discountQuantity", "discount_quantity"),
			netCredits: requiredBillingNumber(item, "netQuantity", "net_quantity"),
			grossUsd: requiredBillingNumber(item, "grossAmount", "gross_amount"),
			discountUsd: requiredBillingNumber(item, "discountAmount", "discount_amount"),
			netUsd: requiredBillingNumber(item, "netAmount", "net_amount"),
		};
		if (Object.values(values).some((value) => value === null)) {
			return { ok: false, error: `usageItems[${index}] has missing or invalid totals` };
		}
		for (const key of Object.keys(values) as (keyof OfficialBillingTotals)[]) {
			totals[key] += values[key] as number;
		}

		const unitType = pickField(item, "unitType", "unit_type");
		if (typeof unitType === "string" && !/ai[-_ ]?credits?/i.test(unitType)) {
			warnings.add(`unexpected billing unitType: ${unitType}`);
		}
	}

	if (!nearlyEqual(totals.grossCredits - totals.discountCredits, totals.netCredits)) {
		warnings.add("grossCredits - discountCredits does not equal netCredits");
	}
	if (!nearlyEqual(totals.grossUsd - totals.discountUsd, totals.netUsd)) {
		warnings.add("grossUsd - discountUsd does not equal netUsd");
	}

	const timePeriodValue = pickField(payload, "timePeriod", "time_period");
	const timePeriod = isRecord(timePeriodValue) ? timePeriodValue : null;
	const year = timePeriod ? finiteNonNegativeInteger(timePeriod.year) : null;
	const month = timePeriod ? finiteNonNegativeInteger(timePeriod.month) : null;

	return {
		ok: true,
		value: {
			totals,
			items: itemsValue.length,
			year,
			month,
			warnings: [...warnings],
		},
	};
}
