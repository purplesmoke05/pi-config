import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Box, Text } from "@earendil-works/pi-tui";
import { minimatch } from "minimatch";
import { parse } from "yaml";

const INSTRUCTIONS_DISABLED = ["1", "true", "yes"].includes(
	(process.env.PI_COPILOT_INSTRUCTIONS_DISABLE ?? "").toLowerCase(),
);
const SKILLS_DISABLED = ["1", "true", "yes"].includes(
	(process.env.PI_COPILOT_SKILLS_DISABLE ?? "").toLowerCase(),
);
const BLOCK_START = "<github_copilot_instructions>";
const BLOCK_END = "</github_copilot_instructions>";
const PATH_MESSAGE_TYPE = "github-copilot-path-instructions";
const REPOSITORY_INSTRUCTIONS = ".github/copilot-instructions.md";
const INSTRUCTIONS_DIR = ".github/instructions";
const SKILLS_DIR = ".github/skills";
const MAX_FILE_CHARS = 20_000;
const MAX_TOTAL_CHARS = 60_000;
const MAX_APPLY_TO_PATTERNS = 64;
const MAX_APPLY_TO_PATTERN_CHARS = 1_024;
const PATH_AWARE_TOOLS = new Set(["read", "edit", "write"]);

interface InstructionFile {
	relPath: string;
	kind: "repository-wide" | "path-specific";
	body: string;
	applyTo: string[];
}

interface InstructionState {
	root: string;
	repositoryWide: InstructionFile[];
	pathSpecific: InstructionFile[];
	activePaths: Set<string>;
	pendingPaths: Set<string>;
}

interface ActivationDetails {
	instructionPaths: string[];
}

function findProjectRoot(cwd: string): string {
	let dir = resolve(cwd);
	for (let i = 0; i < 32; i++) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = resolve(dir, "..");
		if (parent === dir) return dir;
		dir = parent;
	}
	return resolve(cwd);
}

function collectInstructionFiles(dir: string, out: string[] = []): string[] {
	if (!existsSync(dir)) return out;

	for (const entry of readdirSync(dir).sort()) {
		const full = join(dir, entry);
		let stat;
		try {
			stat = lstatSync(full);
		} catch {
			continue;
		}
		if (stat.isSymbolicLink()) continue;
		if (stat.isDirectory()) {
			collectInstructionFiles(full, out);
			continue;
		}
		if (stat.isFile() && entry.endsWith(".instructions.md")) {
			out.push(full);
		}
	}

	return out;
}

function splitFrontmatter(raw: string): { body: string; frontmatter?: string } {
	const normalized = raw.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---\n")) {
		return { body: normalized.trim() };
	}

	const end = normalized.indexOf("\n---\n", 4);
	if (end === -1) {
		return { body: normalized.trim() };
	}

	return {
		frontmatter: normalized.slice(4, end).trim(),
		body: normalized.slice(end + "\n---\n".length).trim(),
	};
}

function splitGlobList(value: string): string[] {
	const patterns: string[] = [];
	let start = 0;
	let braceDepth = 0;
	let bracketDepth = 0;

	for (let i = 0; i < value.length; i++) {
		const character = value[i];
		if (character === "{") braceDepth++;
		else if (character === "}" && braceDepth > 0) braceDepth--;
		else if (character === "[") bracketDepth++;
		else if (character === "]" && bracketDepth > 0) bracketDepth--;
		else if (character === "," && braceDepth === 0 && bracketDepth === 0) {
			const pattern = value.slice(start, i).trim();
			if (pattern) patterns.push(pattern);
			start = i + 1;
		}
	}

	const finalPattern = value.slice(start).trim();
	if (finalPattern) patterns.push(finalPattern);
	return patterns;
}

function extractApplyTo(frontmatter: string | undefined, sourcePath: string): string[] {
	if (!frontmatter) return [];
	const parsed = parse(frontmatter) as unknown;
	if (typeof parsed !== "object" || parsed === null || !("applyTo" in parsed)) return [];

	const applyTo = (parsed as { applyTo?: unknown }).applyTo;
	if (applyTo === undefined || applyTo === null) return [];
	const values = Array.isArray(applyTo) ? applyTo : [applyTo];
	if (!values.every((value) => typeof value === "string")) {
		throw new TypeError(`${sourcePath}: applyTo must be a string or a list of strings`);
	}

	const patterns = values.flatMap((value) => splitGlobList(value));
	if (patterns.length > MAX_APPLY_TO_PATTERNS) {
		throw new RangeError(`${sourcePath}: applyTo exceeds ${MAX_APPLY_TO_PATTERNS} patterns`);
	}
	if (patterns.some((pattern) => pattern.length > MAX_APPLY_TO_PATTERN_CHARS)) {
		throw new RangeError(`${sourcePath}: an applyTo pattern exceeds ${MAX_APPLY_TO_PATTERN_CHARS} characters`);
	}
	return patterns;
}

function truncateFile(content: string): string {
	if (content.length <= MAX_FILE_CHARS) return content;
	return `${content.slice(0, MAX_FILE_CHARS)}\n\n[truncated: GitHub Copilot instruction file exceeded ${MAX_FILE_CHARS} characters]`;
}

function readInstruction(absPath: string, root: string, kind: InstructionFile["kind"]): InstructionFile | undefined {
	const raw = readFileSync(absPath, "utf8");
	const parsed = splitFrontmatter(raw);
	if (!parsed.body) return undefined;
	const relPath = relative(root, absPath).replace(/\\/g, "/");

	return {
		relPath,
		kind,
		body: truncateFile(parsed.body),
		applyTo: extractApplyTo(parsed.frontmatter, relPath),
	};
}

function discoverInstructions(root: string): InstructionFile[] {
	const files: InstructionFile[] = [];
	const repoWide = join(root, REPOSITORY_INSTRUCTIONS);
	if (existsSync(repoWide)) {
		const instruction = readInstruction(repoWide, root, "repository-wide");
		if (instruction) files.push(instruction);
	}

	for (const file of collectInstructionFiles(join(root, INSTRUCTIONS_DIR))) {
		const instruction = readInstruction(file, root, "path-specific");
		if (instruction) files.push(instruction);
	}

	return files;
}

function escapeAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function renderInstruction(file: InstructionFile): string {
	const attrs = [
		`path="${escapeAttribute(file.relPath)}"`,
		`kind="${file.kind}"`,
		file.applyTo.length > 0 ? `applyTo="${escapeAttribute(file.applyTo.join(","))}"` : undefined,
	]
		.filter(Boolean)
		.join(" ");

	return `<instruction ${attrs}>\n${file.body}\n</instruction>`;
}

function renderInstructions(files: InstructionFile[], headerText: string): string {
	const header = [headerText, BLOCK_START].join("\n");

	let rendered = `${header}\n${files.map(renderInstruction).join("\n\n")}\n${BLOCK_END}`;
	if (rendered.length <= MAX_TOTAL_CHARS) return rendered;

	const kept: InstructionFile[] = [];
	for (const file of files) {
		const next = `${header}\n${[...kept, file].map(renderInstruction).join("\n\n")}\n${BLOCK_END}`;
		if (next.length > MAX_TOTAL_CHARS) break;
		kept.push(file);
	}

	rendered = `${header}\n${kept.map(renderInstruction).join("\n\n")}\n[truncated: total GitHub Copilot instruction context exceeded ${MAX_TOTAL_CHARS} characters]\n${BLOCK_END}`;
	return rendered;
}

function isInsideRoot(relativePath: string): boolean {
	return (
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
	);
}

function normalizeProjectPath(root: string, cwd: string, filePath: string): string | undefined {
	const absolutePath = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
	const relativePath = relative(root, absolutePath);
	if (!isInsideRoot(relativePath) || relativePath === "") return undefined;
	return relativePath.replace(/\\/g, "/");
}

function normalizePattern(pattern: string): string {
	return pattern.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "");
}

function matchesApplyTo(file: InstructionFile, projectPath: string): boolean {
	return file.applyTo.some((pattern) =>
		minimatch(projectPath, normalizePattern(pattern), {
			dot: true,
			nonegate: true,
		}),
	);
}

function decodeXmlAttribute(value: string): string {
	const entities: Record<string, string> = {
		amp: "&",
		apos: "'",
		quot: '"',
		lt: "<",
		gt: ">",
	};
	return value.replace(/&(amp|apos|quot|lt|gt);/g, (match, entity: string) => entities[entity] ?? match);
}

function promptFilePaths(prompt: string): string[] {
	const paths: string[] = [];
	const fileTag = /<file\b[^>]*\bname=(?:"([^"]+)"|'([^']+)')[^>]*>/g;
	for (const match of prompt.matchAll(fileTag)) {
		paths.push(decodeXmlAttribute(match[1] ?? match[2]));
	}
	return paths;
}

function activationPaths(entries: readonly SessionEntry[]): Set<string> {
	const active = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom_message" || entry.customType !== PATH_MESSAGE_TYPE) continue;
		const details = entry.details as Partial<ActivationDetails> | undefined;
		if (!Array.isArray(details?.instructionPaths)) continue;
		for (const instructionPath of details.instructionPaths) {
			if (typeof instructionPath === "string") active.add(instructionPath);
		}
	}
	return active;
}

function retainedActivationPaths(
	entries: readonly SessionEntry[],
	compactionId: string,
	firstKeptEntryId: string,
): Set<string> {
	const compactionIndex = entries.findIndex((entry) => entry.id === compactionId);
	const firstKeptIndex = entries.findIndex((entry) => entry.id === firstKeptEntryId);
	if (compactionIndex === -1 || firstKeptIndex === -1 || firstKeptIndex >= compactionIndex) {
		return new Set<string>();
	}
	return activationPaths(entries.slice(firstKeptIndex, compactionIndex));
}

function createState(ctx: ExtensionContext): InstructionState {
	const root = findProjectRoot(ctx.cwd);
	const files = discoverInstructions(root);
	return {
		root,
		repositoryWide: files.filter((file) => file.kind === "repository-wide"),
		pathSpecific: files.filter((file) => file.kind === "path-specific"),
		activePaths: activationPaths(ctx.sessionManager.getBranch()),
		pendingPaths: new Set<string>(),
	};
}

function matchingInactiveInstructions(
	state: InstructionState,
	cwd: string,
	filePaths: readonly string[],
): InstructionFile[] {
	const projectPaths = filePaths
		.map((filePath) => normalizeProjectPath(state.root, cwd, filePath))
		.filter((filePath): filePath is string => filePath !== undefined);
	if (projectPaths.length === 0) return [];

	return state.pathSpecific.filter(
		(file) =>
			!state.activePaths.has(file.relPath) &&
			!state.pendingPaths.has(file.relPath) &&
			file.applyTo.length > 0 &&
			projectPaths.some((projectPath) => matchesApplyTo(file, projectPath)),
	);
}

function activationMessage(files: InstructionFile[], display = true) {
	return {
		customType: PATH_MESSAGE_TYPE,
		content: renderInstructions(
			files,
			"GitHub Copilot path-specific instructions activated because their applyTo patterns matched files in this conversation. Follow these instructions for the remainder of the conversation.",
		),
		display,
		details: { instructionPaths: files.map((file) => file.relPath) } satisfies ActivationDetails,
	};
}

function activationLabel(paths: readonly string[], expanded: boolean): string {
	if (paths.length === 0) return "Copilot instructions activated";
	if (expanded) return `Copilot instructions activated\n${paths.map((path) => `  ${path}`).join("\n")}`;
	const visible = paths.slice(0, 2).map((path) => basename(path));
	const overflow = paths.length > visible.length ? ` (+${paths.length - visible.length})` : "";
	return `Copilot instructions activated · ${visible.join(", ")}${overflow}`;
}

function toolPath(event: ToolCallEvent): string | undefined {
	if (!PATH_AWARE_TOOLS.has(event.toolName)) return undefined;
	const value = (event.input as { path?: unknown }).path;
	return typeof value === "string" ? value : undefined;
}

export default function (pi: ExtensionAPI) {
	let state: InstructionState | undefined;

	pi.registerMessageRenderer<ActivationDetails>(PATH_MESSAGE_TYPE, (message, { expanded }, theme) => {
		const paths = Array.isArray(message.details?.instructionPaths)
			? message.details.instructionPaths.filter((path): path is string => typeof path === "string")
			: [];
		const label = activationLabel(paths, expanded);
		const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("accent", label), 0, 0));
		return box;
	});

	if (!SKILLS_DISABLED) {
		pi.on("resources_discover", async (event) => {
			const root = findProjectRoot(event.cwd);
			const skillsDir = join(root, SKILLS_DIR);
			return existsSync(skillsDir) ? { skillPaths: [skillsDir] } : {};
		});
	}

	if (INSTRUCTIONS_DISABLED) return;

	pi.on("session_start", (_event, ctx) => {
		state = createState(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		state = createState(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		state ??= createState(ctx);
		const matched = matchingInactiveInstructions(state, ctx.cwd, promptFilePaths(event.prompt));
		for (const file of matched) state.activePaths.add(file.relPath);

		const result: {
			message?: ReturnType<typeof activationMessage>;
			systemPrompt?: string;
		} = {};
		if (matched.length > 0) result.message = activationMessage(matched);
		if (state.repositoryWide.length > 0 && !event.systemPrompt.includes(BLOCK_START)) {
			result.systemPrompt = `${event.systemPrompt}\n\n${renderInstructions(
				state.repositoryWide,
				"GitHub Copilot repository-wide instructions discovered at the start of this conversation.",
			)}`;
		}
		return result;
	});

	pi.on("tool_call", (event, ctx) => {
		state ??= createState(ctx);
		const path = toolPath(event);
		if (!path) return;
		for (const file of matchingInactiveInstructions(state, ctx.cwd, [path])) {
			state.pendingPaths.add(file.relPath);
		}
	});

	pi.on("turn_end", () => {
		if (!state || state.pendingPaths.size === 0) return;
		const currentState = state;
		const pending = currentState.pathSpecific.filter((file) => currentState.pendingPaths.has(file.relPath));
		currentState.pendingPaths.clear();
		if (pending.length === 0) return;
		for (const file of pending) currentState.activePaths.add(file.relPath);
		pi.sendMessage(activationMessage(pending), { deliverAs: "steer" });
	});

	pi.on("agent_end", () => {
		state?.pendingPaths.clear();
	});

	pi.on("session_compact", (event, ctx) => {
		if (!state) return;
		const currentState = state;
		const retained = retainedActivationPaths(
			ctx.sessionManager.getBranch(),
			event.compactionEntry.id,
			event.compactionEntry.firstKeptEntryId,
		);
		const missing = currentState.pathSpecific.filter(
			(file) => currentState.activePaths.has(file.relPath) && !retained.has(file.relPath),
		);
		if (missing.length === 0) return;
		pi.sendMessage(activationMessage(missing, false), { deliverAs: "steer" });
	});
}
