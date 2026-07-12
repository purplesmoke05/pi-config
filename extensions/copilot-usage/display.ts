import { isAbsolute, relative, sep } from "node:path";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { estimateTextTokens } from "./usage.ts";

export interface CopilotStatusInput {
	requestKind: "next-base" | "sending";
	requestTokens: number | null;
	branchInputTokens: number;
	branchOutputTokens: number;
	creditEstimate: string;
}

export type InitialContextFileKind = "native-context" | "copilot-instruction" | "attachment";

export interface InitialContextFile {
	kind: InitialContextFileKind;
	path: string;
	tokens: number;
}

export interface InitialRequestBreakdownInput {
	systemPrompt: string;
	initialPrompt: string;
	nativeContextFiles?: readonly { path: string; content: string }[];
	requestTokens: number | null;
	toolTokens: number;
	cwd: string;
	home?: string;
}

export interface InitialRequestTokenBreakdown {
	requestTokens: number | null;
	systemTokens: number;
	toolTokens: number;
	restTokens: number | null;
	system: {
		baseOther: number;
		nativeContext: number;
		copilotInstructions: number;
		skills: number;
	};
	files: InitialContextFile[];
}

interface TagBlock {
	openingTag: string;
	content: string;
	raw: string;
	start: number;
	end: number;
}

type SystemBlockKind = "native-context" | "copilot-instructions" | "skills";

interface SystemBlock {
	kind: SystemBlockKind;
	block: TagBlock;
}

const MAX_WIDGET_LINES = 10;
const MAX_WIDGET_LINE_WIDTH = 80;

function compactTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)}m`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
	return String(value);
}

export function formatCopilotStatus(input: CopilotStatusInput): string {
	const requestLabel = input.requestKind === "sending" ? "sending" : "next base";
	const requestValue = input.requestTokens === null ? "≈? tok" : `≈${compactTokens(input.requestTokens)} tok`;
	return (
		`Copilot ${requestLabel}${requestValue}` +
		` · branch ${input.creditEstimate}, ${compactTokens(input.branchInputTokens)} in/` +
		`${compactTokens(input.branchOutputTokens)} out tok`
	);
}

function decodeXmlAttribute(value: string): string {
	const entities: Record<string, string> = {
		amp: "&",
		quot: '"',
		lt: "<",
		gt: ">",
	};
	return value.replace(/&(amp|quot|lt|gt);/g, (_match, entity: string) => entities[entity] ?? _match);
}

function isInside(relativePath: string): boolean {
	return (
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
	);
}

function escapeDisplayControls(value: string): string {
	return value.replace(
		/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
		(character) => {
			if (character === "\n") return "\\n";
			if (character === "\r") return "\\r";
			if (character === "\t") return "\\t";
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint <= 0xff
				? `\\x${codePoint.toString(16).padStart(2, "0")}`
				: `\\u${codePoint.toString(16).padStart(4, "0")}`;
		},
	);
}

function normalizeDisplayPath(filePath: string, cwd: string, home?: string): string {
	if (!isAbsolute(filePath)) return escapeDisplayControls(filePath.replace(/\\/g, "/"));

	const cwdRelative = relative(cwd, filePath);
	if (isInside(cwdRelative)) return escapeDisplayControls((cwdRelative || ".").replace(/\\/g, "/"));

	if (home) {
		const homeRelative = relative(home, filePath);
		if (isInside(homeRelative)) return escapeDisplayControls(`~/${homeRelative.replace(/\\/g, "/")}`);
	}

	return escapeDisplayControls(filePath.replace(/\\/g, "/"));
}

function extractTagBlocks(text: string, tag: string): TagBlock[] {
	const blocks: TagBlock[] = [];
	const tagPattern = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, "g");
	let depth = 0;
	let start = -1;
	let contentStart = -1;
	let openingTag = "";

	for (let match = tagPattern.exec(text); match; match = tagPattern.exec(text)) {
		const isClosing = match[0].startsWith("</");
		const isSelfClosing = !isClosing && match[0].endsWith("/>");
		if (isSelfClosing) {
			if (depth === 0) {
				blocks.push({
					openingTag: match[0],
					content: "",
					raw: match[0],
					start: match.index,
					end: tagPattern.lastIndex,
				});
			}
			continue;
		}
		if (!isClosing) {
			if (depth === 0) {
				start = match.index;
				contentStart = tagPattern.lastIndex;
				openingTag = match[0];
			}
			depth++;
			continue;
		}
		if (depth === 0) continue;
		depth--;
		if (depth !== 0) continue;
		blocks.push({
			openingTag,
			content: text.slice(contentStart, match.index),
			raw: text.slice(start, tagPattern.lastIndex),
			start,
			end: tagPattern.lastIndex,
		});
	}

	if (depth > 0 && start >= 0 && contentStart >= 0) {
		blocks.push({
			openingTag,
			content: "",
			raw: text.slice(start, contentStart),
			start,
			end: contentStart,
		});
	}

	return blocks;
}

function structuredNativeBlocks(
	systemPrompt: string,
	files: readonly { path: string; content: string }[],
): TagBlock[] {
	const blocks: TagBlock[] = [];
	let cursor = 0;
	for (const file of files) {
		const openingTag = `<project_instructions path="${file.path}">`;
		const raw = `${openingTag}\n${file.content}\n</project_instructions>`;
		const start = systemPrompt.indexOf(raw, cursor);
		if (start === -1) continue;
		const contentStart = start + openingTag.length;
		const end = start + raw.length;
		blocks.push({
			openingTag,
			content: systemPrompt.slice(contentStart, end - "</project_instructions>".length),
			raw,
			start,
			end,
		});
		cursor = end;
	}
	return blocks;
}

function blockAttribute(block: TagBlock, attribute: string): string | null {
	const match = new RegExp(`\\b${attribute}="([^"]+)"`).exec(block.openingTag);
	return match?.[1] ?? null;
}

function nonOverlappingSystemBlocks(blocks: readonly SystemBlock[]): SystemBlock[] {
	const sorted = [...blocks].sort(
		(left, right) => left.block.start - right.block.start || right.block.end - left.block.end,
	);
	const selected: SystemBlock[] = [];
	for (const candidate of sorted) {
		const overlaps = selected.some(
			(existing) =>
				candidate.block.start < existing.block.end && candidate.block.end > existing.block.start,
		);
		if (!overlaps) selected.push(candidate);
	}
	return selected;
}

function textOutsideBlocks(text: string, blocks: readonly TagBlock[]): string {
	const sorted = [...blocks].sort((left, right) => left.start - right.start);
	const parts: string[] = [];
	let cursor = 0;
	for (const block of sorted) {
		if (block.start < cursor) continue;
		parts.push(text.slice(cursor, block.start));
		cursor = block.end;
	}
	parts.push(text.slice(cursor));
	return parts.join("");
}

function sumBlockTokens(blocks: readonly TagBlock[]): number {
	return blocks.reduce((total, block) => total + estimateTextTokens(block.raw), 0);
}

export function collectInitialRequestBreakdown(
	input: InitialRequestBreakdownInput,
): InitialRequestTokenBreakdown {
	const files: InitialContextFile[] = [];
	const fileIndexes = new Map<string, number>();
	const addFile = (
		kind: InitialContextFileKind,
		sourcePath: string,
		raw: string,
		xmlEncoded = false,
	): void => {
		const filePath = xmlEncoded ? decodeXmlAttribute(sourcePath) : sourcePath;
		const path = normalizeDisplayPath(filePath, input.cwd, input.home);
		if (!path) return;
		const key = `${kind}\0${path}`;
		const tokens = estimateTextTokens(raw);
		const existingIndex = fileIndexes.get(key);
		if (existingIndex !== undefined) {
			files[existingIndex] = {
				...files[existingIndex],
				tokens: files[existingIndex].tokens + tokens,
			};
			return;
		}
		fileIndexes.set(key, files.length);
		files.push({ kind, path, tokens });
	};

	const nativeCandidates =
		input.nativeContextFiles === undefined
			? extractTagBlocks(input.systemPrompt, "project_instructions")
			: structuredNativeBlocks(input.systemPrompt, input.nativeContextFiles);
	const systemBlocks = nonOverlappingSystemBlocks([
		...nativeCandidates.map((block) => ({
			kind: "native-context" as const,
			block,
		})),
		...extractTagBlocks(input.systemPrompt, "github_copilot_instructions").map((block) => ({
			kind: "copilot-instructions" as const,
			block,
		})),
		...extractTagBlocks(input.systemPrompt, "available_skills").map((block) => ({
			kind: "skills" as const,
			block,
		})),
	]);
	const nativeBlocks = systemBlocks
		.filter((entry) => entry.kind === "native-context")
		.map((entry) => entry.block);
	for (const block of nativeBlocks) {
		const path = blockAttribute(block, "path");
		if (path) addFile("native-context", path, block.raw);
	}

	const copilotBlocks = systemBlocks
		.filter((entry) => entry.kind === "copilot-instructions")
		.map((entry) => entry.block);
	for (const wrapper of copilotBlocks) {
		for (const block of extractTagBlocks(wrapper.content, "instruction")) {
			const path = blockAttribute(block, "path");
			if (path) addFile("copilot-instruction", path, block.raw, true);
		}
	}

	for (const block of extractTagBlocks(input.initialPrompt, "file")) {
		const path = blockAttribute(block, "name");
		if (path) addFile("attachment", path, block.raw);
	}

	const skillBlocks = systemBlocks
		.filter((entry) => entry.kind === "skills")
		.map((entry) => entry.block);
	const categorizedBlocks = systemBlocks.map((entry) => entry.block);
	const system = {
		baseOther: estimateTextTokens(textOutsideBlocks(input.systemPrompt, categorizedBlocks)),
		nativeContext: sumBlockTokens(nativeBlocks),
		copilotInstructions: sumBlockTokens(copilotBlocks),
		skills: sumBlockTokens(skillBlocks),
	};
	const systemTokens =
		system.baseOther + system.nativeContext + system.copilotInstructions + system.skills;
	const classifiedTokens = systemTokens + input.toolTokens;
	const restTokens =
		input.requestTokens === null || input.requestTokens < classifiedTokens
			? null
			: input.requestTokens - classifiedTokens;

	return {
		requestTokens: input.requestTokens,
		systemTokens,
		toolTokens: input.toolTokens,
		restTokens,
		system,
		files,
	};
}

function estimatedTokens(value: number | null): string {
	return value === null ? "≈?" : `≈${compactTokens(value)}`;
}

function truncateMiddleToWidth(value: string, maximumWidth: number): string {
	const width = visibleWidth(value);
	if (width <= maximumWidth) return value;
	if (maximumWidth <= 1) return "…";
	const contentWidth = maximumWidth - 1;
	const leftWidth = Math.ceil(contentWidth / 2);
	const rightWidth = Math.floor(contentWidth / 2);
	return (
		sliceByColumn(value, 0, leftWidth, true) +
		"…" +
		sliceByColumn(value, width - rightWidth, rightWidth, true)
	);
}

function formatFileLine(file: InitialContextFile): string {
	const prefix = "  ";
	const suffix = ` ${estimatedTokens(file.tokens)} tok`;
	const pathWidth = Math.max(1, MAX_WIDGET_LINE_WIDTH - visibleWidth(prefix) - visibleWidth(suffix));
	return `${prefix}${truncateMiddleToWidth(file.path, pathWidth)}${suffix}`;
}

function visibleGroupLines(files: readonly InitialContextFile[], budget: number): string[] {
	if (files.length <= budget) {
		return files.map(formatFileLine);
	}
	if (budget <= 1) {
		const tokens = files.reduce((total, file) => total + file.tokens, 0);
		return [`  … ${files.length} files ${estimatedTokens(tokens)} tok`];
	}
	const visible = files.slice(0, budget - 1);
	const hidden = files.slice(visible.length);
	const hiddenTokens = hidden.reduce((total, file) => total + file.tokens, 0);
	return [
		...visible.map(formatFileLine),
		`  … ${hidden.length} more ${estimatedTokens(hiddenTokens)} tok`,
	];
}

export function formatInitialContextWidget(breakdown: InitialRequestTokenBreakdown): string[] {
	const lines = [
		`Copilot first request · local token estimates · ${breakdown.files.length} files`,
		`request${estimatedTokens(breakdown.requestTokens)} · system${estimatedTokens(breakdown.systemTokens)}` +
			` · tools${estimatedTokens(breakdown.toolTokens)} · rest${estimatedTokens(breakdown.restTokens)} tok`,
		`system: base/other${estimatedTokens(breakdown.system.baseOther)}` +
			` · auto${estimatedTokens(breakdown.system.nativeContext)}` +
			` · Copilot${estimatedTokens(breakdown.system.copilotInstructions)}` +
			` · skills${estimatedTokens(breakdown.system.skills)} tok`,
	];
	if (breakdown.files.length === 0) return [...lines, "  no tagged file paths detected"];

	const groups = [
		{
			label: "automatic context",
			files: breakdown.files.filter((file) => file.kind !== "attachment"),
		},
		{
			label: "prompt file tags",
			files: breakdown.files.filter((file) => file.kind === "attachment"),
		},
	].filter((group) => group.files.length > 0);
	const pathBudget = MAX_WIDGET_LINES - lines.length - groups.length;
	const allocations = groups.map((group) => Math.min(group.files.length, 2));
	let remaining = pathBudget - allocations.reduce((total, allocation) => total + allocation, 0);
	while (remaining > 0) {
		let selected = -1;
		let largestUnallocated = 0;
		for (let index = 0; index < groups.length; index++) {
			const unallocated = groups[index].files.length - allocations[index];
			if (unallocated > largestUnallocated) {
				selected = index;
				largestUnallocated = unallocated;
			}
		}
		if (selected === -1) break;
		allocations[selected]++;
		remaining--;
	}

	for (let index = 0; index < groups.length; index++) {
		lines.push(`${groups[index].label}:`, ...visibleGroupLines(groups[index].files, allocations[index]));
	}
	return lines;
}
