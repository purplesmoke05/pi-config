import { isAbsolute, relative, sep } from "node:path";

export interface CopilotStatusInput {
	requestKind: "next-base" | "sending";
	requestTokens: number | null;
	branchInputTokens: number;
	branchOutputTokens: number;
	creditEstimate: string;
}

export type InitialContextFileKind = "context" | "attachment";

export interface InitialContextFile {
	kind: InitialContextFileKind;
	path: string;
}

export interface InitialContextFileInput {
	systemPrompt: string;
	initialPrompt: string;
	cwd: string;
	home?: string;
}

const MAX_WIDGET_LINES = 10;

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

function extractWrappedAttribute(text: string, tag: string, attribute: string): string[] {
	const values: string[] = [];
	const openingTag = new RegExp(`<${tag}\\b[^>]*\\b${attribute}="([^"]+)"[^>]*>`, "g");
	const closingTag = `</${tag}>`;
	let cursor = 0;

	while (cursor < text.length) {
		openingTag.lastIndex = cursor;
		const match = openingTag.exec(text);
		if (!match) break;
		values.push(match[1]);
		const closingIndex = text.indexOf(closingTag, openingTag.lastIndex);
		cursor = closingIndex === -1 ? openingTag.lastIndex : closingIndex + closingTag.length;
	}

	return values;
}

export function collectInitialContextFiles(input: InitialContextFileInput): InitialContextFile[] {
	const files: InitialContextFile[] = [];
	const seen = new Set<string>();
	const add = (kind: InitialContextFileKind, sourcePath: string, xmlEncoded = false): void => {
		const filePath = xmlEncoded ? decodeXmlAttribute(sourcePath) : sourcePath;
		const path = normalizeDisplayPath(filePath, input.cwd, input.home);
		const key = `${kind}\0${path}`;
		if (!path || seen.has(key)) return;
		seen.add(key);
		files.push({ kind, path });
	};

	for (const path of extractWrappedAttribute(input.systemPrompt, "project_instructions", "path")) {
		add("context", path);
	}

	for (const block of input.systemPrompt.matchAll(
		/<github_copilot_instructions>([\s\S]*?)<\/github_copilot_instructions>/g,
	)) {
		for (const path of extractWrappedAttribute(block[1], "instruction", "path")) add("context", path, true);
	}

	for (const path of extractWrappedAttribute(input.initialPrompt, "file", "name")) add("attachment", path);

	return files;
}

function visibleGroupLines(paths: readonly string[], budget: number): string[] {
	if (paths.length <= budget) return paths.map((path) => `  ${path}`);
	if (budget <= 1) return [`  … ${paths.length} files`];
	const visible = paths.slice(0, budget - 1);
	return [...visible.map((path) => `  ${path}`), `  … ${paths.length - visible.length} more`];
}

export function formatInitialContextWidget(files: readonly InitialContextFile[]): string[] {
	const lines = [`Copilot first request · tagged files detected (${files.length})`];
	if (files.length === 0) {
		return [...lines, "  no tagged file paths detected", "  system prompt and tool schemas are still included"];
	}

	const groups = [
		{
			label: "automatic context",
			paths: files.filter((file) => file.kind === "context").map((file) => file.path),
		},
		{
			label: "prompt file tags",
			paths: files.filter((file) => file.kind === "attachment").map((file) => file.path),
		},
	].filter((group) => group.paths.length > 0);
	const pathBudget = MAX_WIDGET_LINES - 1 - groups.length;
	const allocations = groups.map((group) => Math.min(group.paths.length, 2));
	let remaining = pathBudget - allocations.reduce((total, allocation) => total + allocation, 0);
	while (remaining > 0) {
		let selected = -1;
		let largestUnallocated = 0;
		for (let index = 0; index < groups.length; index++) {
			const unallocated = groups[index].paths.length - allocations[index];
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
		lines.push(`${groups[index].label}:`, ...visibleGroupLines(groups[index].paths, allocations[index]));
	}
	return lines;
}
