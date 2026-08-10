import { createHash } from "node:crypto";

/**
 * Shared session-aggregation and model helpers for the GitHub Copilot
 * extensions. `copilot-usage` and `copilot-credit` both import from here so
 * they agree on session credit totals, provider activation, and UTC month
 * boundaries without depending on each other. This directory has no
 * `index.ts`, so pi does not load it as an extension.
 */

export const COPILOT_PROVIDER = "github-copilot";
export const CREDIT_USD = 0.01;
export const PRICING_EFFECTIVE_FROM = "2026-06-01";

const DISABLED_VALUES = new Set(["1", "true", "yes"]);
const PRICING_EFFECTIVE_FROM_MS = Date.UTC(2026, 5, 1);

interface LongContextPrice {
	threshold: number;
	input: number;
	cacheRead: number;
	output: number;
}

// GitHub applies these rates to the entire request once prompt input exceeds
// the threshold. Standard-rate requests use the cost stored by Pi at the time
// of the response, which avoids rewriting old history with today's prices.
const LONG_CONTEXT_PRICES: Readonly<Record<string, LongContextPrice>> = {
	"gpt-5.4": { threshold: 272_000, input: 5, cacheRead: 0.5, output: 22.5 },
	"gpt-5.5": { threshold: 272_000, input: 10, cacheRead: 1, output: 45 },
	"gemini-3.1-pro-preview": { threshold: 200_000, input: 4, cacheRead: 0.4, output: 18 },
};

export interface ModelLike {
	provider?: unknown;
}

export interface UsageTotals {
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	grossCredits: number;
	creditsComplete: boolean;
}

export interface UsageAggregate extends UsageTotals {
	byModel: Record<string, UsageTotals>;
	warnings: string[];
	unattributedInternalCalls: number;
}

export interface UtcMonthPeriod {
	year: number;
	month: number;
	startMs: number;
	endMs: number;
}

export interface SessionRecord {
	path: string;
	entries: readonly unknown[];
}

export interface HistoryAggregate extends UsageAggregate {
	filesScanned: number;
	duplicatesRemoved: number;
	period: UtcMonthPeriod;
}

export interface ParsedSessionJsonl {
	entries: unknown[];
	errors: string[];
}

interface ParsedAssistant {
	message: Record<string, unknown>;
	model: string;
	timestampMs: number | null;
	usage: ParsedUsage | null;
	usageError?: string;
}

interface ParsedUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h: number;
	costTotalUsd: number | null;
}

interface CreditEstimate {
	credits: number | null;
	warning?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCopilotModel(model: ModelLike | null | undefined): boolean {
	return model?.provider === COPILOT_PROVIDER;
}

export function isCopilotUsageDisabled(
	env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	return DISABLED_VALUES.has((env.PI_COPILOT_USAGE_DISABLE ?? "").toLowerCase());
}

export function finiteNonNegativeInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
		? value
		: null;
}

export function finiteNonNegativeNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseUsage(message: Record<string, unknown>): { usage: ParsedUsage | null; error?: string } {
	if (!isRecord(message.usage)) return { usage: null, error: "missing usage" };
	const usage = message.usage;
	const input = finiteNonNegativeInteger(usage.input);
	const output = finiteNonNegativeInteger(usage.output);
	const cacheRead = finiteNonNegativeInteger(usage.cacheRead);
	const cacheWrite = finiteNonNegativeInteger(usage.cacheWrite);
	const cacheWrite1h = usage.cacheWrite1h === undefined ? 0 : finiteNonNegativeInteger(usage.cacheWrite1h);

	if (input === null || output === null || cacheRead === null || cacheWrite === null || cacheWrite1h === null) {
		return { usage: null, error: "invalid token usage" };
	}
	if (cacheWrite1h > cacheWrite) return { usage: null, error: "cacheWrite1h exceeds cacheWrite" };

	const recordedCost = isRecord(usage.cost) ? finiteNonNegativeNumber(usage.cost.total) : null;
	const hasBillableTokens = input + output + cacheRead + cacheWrite > 0;
	const costTotalUsd = recordedCost === 0 && hasBillableTokens ? null : recordedCost;
	return {
		usage: { input, output, cacheRead, cacheWrite, cacheWrite1h, costTotalUsd },
		...(costTotalUsd === null
			? { error: recordedCost === 0 ? "positive usage has zero recorded cost" : "missing or invalid recorded cost" }
			: {}),
	};
}

function timestampFrom(entry: Record<string, unknown>, message: Record<string, unknown>): number | null {
	if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) return message.timestamp;
	if (typeof entry.timestamp !== "string") return null;
	const timestamp = Date.parse(entry.timestamp);
	return Number.isFinite(timestamp) ? timestamp : null;
}

function parseCopilotAssistantEntry(entryValue: unknown): ParsedAssistant | null {
	if (!isRecord(entryValue) || entryValue.type !== "message" || !isRecord(entryValue.message)) return null;
	const message = entryValue.message;
	if (message.role !== "assistant" || message.provider !== COPILOT_PROVIDER) return null;
	const parsed = parseUsage(message);
	return {
		message,
		model: typeof message.model === "string" && message.model ? message.model : "unknown",
		timestampMs: timestampFrom(entryValue, message),
		usage: parsed.usage,
		usageError: parsed.error,
	};
}

function estimateGrossCredits(
	model: string,
	usage: ParsedUsage,
	timestampMs: number | null,
): CreditEstimate {
	const longPrice = LONG_CONTEXT_PRICES[model];
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	if (longPrice && promptTokens > longPrice.threshold) {
		if (timestampMs === null || timestampMs < PRICING_EFFECTIVE_FROM_MS) {
			if (usage.costTotalUsd === null) {
				return { credits: null, warning: `${model}: historical long-context price is unavailable` };
			}
			return {
				credits: usage.costTotalUsd / CREDIT_USD,
				warning: `${model}: pre-${PRICING_EFFECTIVE_FROM} long-context call uses Pi's stored cost`,
			};
		}
		if (usage.cacheWrite > 0 || usage.cacheWrite1h > 0) {
			return {
				credits: null,
				warning: `${model}: long-context cache-write pricing is unavailable`,
			};
		}
		const usd =
			(usage.input * longPrice.input + usage.cacheRead * longPrice.cacheRead + usage.output * longPrice.output) /
			1_000_000;
		return { credits: usd / CREDIT_USD };
	}

	if (usage.costTotalUsd === null) {
		return { credits: null, warning: `${model}: Pi did not record a usable cost` };
	}
	return { credits: usage.costTotalUsd / CREDIT_USD };
}

function emptyTotals(): UsageTotals {
	return {
		calls: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		grossCredits: 0,
		creditsComplete: true,
	};
}

interface AggregateBuilder {
	totals: UsageTotals;
	byModel: Record<string, UsageTotals>;
	warnings: Set<string>;
	unattributedInternalCalls: number;
}

function createBuilder(): AggregateBuilder {
	return { totals: emptyTotals(), byModel: {}, warnings: new Set<string>(), unattributedInternalCalls: 0 };
}

function isUnattributedInternalCall(entry: unknown): entry is Record<string, unknown> {
	return (
		isRecord(entry) &&
		(entry.type === "compaction" || entry.type === "branch_summary") &&
		entry.fromHook !== true
	);
}

function addUnattributedInternalCall(builder: AggregateBuilder): void {
	builder.unattributedInternalCalls++;
	builder.totals.creditsComplete = false;
}

function addAssistant(builder: AggregateBuilder, assistant: ParsedAssistant): void {
	builder.totals.calls++;
	const modelTotals = builder.byModel[assistant.model] ?? emptyTotals();
	modelTotals.calls++;
	builder.byModel[assistant.model] = modelTotals;

	if (!assistant.usage) {
		builder.totals.creditsComplete = false;
		modelTotals.creditsComplete = false;
		builder.warnings.add(`${assistant.model}: ${assistant.usageError ?? "invalid usage"}`);
		return;
	}

	const usage = assistant.usage;
	const totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	for (const totals of [builder.totals, modelTotals]) {
		totals.input += usage.input;
		totals.output += usage.output;
		totals.cacheRead += usage.cacheRead;
		totals.cacheWrite += usage.cacheWrite;
		totals.totalTokens += totalTokens;
	}

	const estimate = estimateGrossCredits(assistant.model, usage, assistant.timestampMs);
	if (estimate.credits === null) {
		builder.totals.creditsComplete = false;
		modelTotals.creditsComplete = false;
		builder.warnings.add(estimate.warning ?? `${assistant.model}: credits unavailable`);
		if (assistant.usageError) builder.warnings.add(`${assistant.model}: ${assistant.usageError}`);
		return;
	}
	builder.totals.grossCredits += estimate.credits;
	modelTotals.grossCredits += estimate.credits;
	if (estimate.warning) builder.warnings.add(estimate.warning);
	if (assistant.usageError) builder.warnings.add(`${assistant.model}: ${assistant.usageError}`);
}

function finishBuilder(builder: AggregateBuilder): UsageAggregate {
	if (builder.unattributedInternalCalls > 0) {
		builder.warnings.add(
			`Pi did not persist provider/usage for ${builder.unattributedInternalCalls} internal compaction or branch-summary call(s)`,
		);
	}
	return {
		...builder.totals,
		byModel: builder.byModel,
		warnings: [...builder.warnings],
		unattributedInternalCalls: builder.unattributedInternalCalls,
	};
}

export function aggregateSessionEntries(entries: readonly unknown[]): UsageAggregate {
	const builder = createBuilder();
	for (const entry of entries) {
		if (isUnattributedInternalCall(entry)) addUnattributedInternalCall(builder);
		const assistant = parseCopilotAssistantEntry(entry);
		if (assistant) addAssistant(builder, assistant);
	}
	return finishBuilder(builder);
}

export function utcMonthPeriod(year: number, month: number): UtcMonthPeriod {
	if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
		throw new RangeError("year/month must identify a UTC calendar month");
	}
	return {
		year,
		month,
		startMs: Date.UTC(year, month - 1, 1),
		endMs: Date.UTC(year, month, 1),
	};
}

export function currentUtcMonth(now = new Date()): UtcMonthPeriod {
	return utcMonthPeriod(now.getUTCFullYear(), now.getUTCMonth() + 1);
}

export function parseUtcMonth(value: string): UtcMonthPeriod | null {
	const match = /^(\d{4})-(\d{2})$/.exec(value.trim());
	if (!match) return null;
	const year = Number(match[1]);
	const month = Number(match[2]);
	try {
		return utcMonthPeriod(year, month);
	} catch {
		return null;
	}
}

function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("non-finite value in session entry");
		return JSON.stringify(value);
	}
	if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
		throw new TypeError(`unsupported ${typeof value} in session entry`);
	}
	if (value === undefined) return "null";
	if (seen.has(value as object)) throw new TypeError("circular session entry");
	seen.add(value as object);
	try {
		if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item, seen)).join(",")}]`;
		if (!isRecord(value)) throw new TypeError("unsupported session entry value");
		const fields = Object.keys(value)
			.filter((key) => value[key] !== undefined)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key], seen)}`);
		return `{${fields.join(",")}}`;
	} finally {
		seen.delete(value as object);
	}
}

function entryFingerprint(entry: unknown): string {
	if (!isRecord(entry) || !isRecord(entry.message)) throw new TypeError("invalid message entry");
	// parentId and entry timestamp can be rewritten while Pi creates a branched
	// session. The entry id and assistant message itself are copied unchanged.
	const canonicalCall = {
		entryId: typeof entry.id === "string" ? entry.id : null,
		message: entry.message,
	};
	return createHash("sha256").update(stableStringify(canonicalCall)).digest("hex");
}

function internalCallFingerprint(entry: Record<string, unknown>): string {
	const canonicalCall = {
		entryId: typeof entry.id === "string" ? entry.id : null,
		type: entry.type,
		timestamp: typeof entry.timestamp === "string" ? entry.timestamp : null,
		summary: typeof entry.summary === "string" ? entry.summary : null,
	};
	return createHash("sha256").update(stableStringify(canonicalCall)).digest("hex");
}

export function aggregateHistory(
	records: readonly SessionRecord[],
	period: UtcMonthPeriod,
): HistoryAggregate {
	const builder = createBuilder();
	const seen = new Set<string>();
	const seenInternalCalls = new Set<string>();
	let duplicatesRemoved = 0;

	for (const record of records) {
		for (const entry of record.entries) {
			if (isUnattributedInternalCall(entry)) {
				const timestamp =
					typeof entry.timestamp === "string" && Number.isFinite(Date.parse(entry.timestamp))
						? Date.parse(entry.timestamp)
						: null;
				if (timestamp === null) {
					builder.totals.creditsComplete = false;
					builder.warnings.add(`${record.path}: internal summary call has no valid timestamp`);
				} else if (timestamp >= period.startMs && timestamp < period.endMs) {
					const fingerprint = internalCallFingerprint(entry);
					if (seenInternalCalls.has(fingerprint)) duplicatesRemoved++;
					else {
						seenInternalCalls.add(fingerprint);
						addUnattributedInternalCall(builder);
					}
				}
			}

			const assistant = parseCopilotAssistantEntry(entry);
			if (!assistant) continue;
			if (assistant.timestampMs === null) {
				builder.totals.creditsComplete = false;
				builder.warnings.add(`${record.path}: Copilot response has no valid timestamp`);
				continue;
			}
			if (assistant.timestampMs < period.startMs || assistant.timestampMs >= period.endMs) continue;

			let fingerprint: string;
			try {
				fingerprint = entryFingerprint(entry);
			} catch (error) {
				builder.totals.creditsComplete = false;
				builder.warnings.add(
					`${record.path}: response could not be fingerprinted (${error instanceof Error ? error.message : String(error)})`,
				);
				fingerprint = `${record.path}:${assistant.timestampMs}:${builder.totals.calls}`;
			}
			if (seen.has(fingerprint)) {
				duplicatesRemoved++;
				continue;
			}
			seen.add(fingerprint);
			addAssistant(builder, assistant);
		}
	}

	return {
		...finishBuilder(builder),
		filesScanned: records.length,
		duplicatesRemoved,
		period,
	};
}

export function parseSessionJsonl(content: string, label = "session"): ParsedSessionJsonl {
	const entries: unknown[] = [];
	const errors: string[] = [];
	const lines = content.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index].trim();
		if (!line) continue;
		try {
			entries.push(JSON.parse(line) as unknown);
		} catch {
			errors.push(`${label}: invalid JSON on line ${index + 1}`);
		}
	}
	return { entries, errors };
}
