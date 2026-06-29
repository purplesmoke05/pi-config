import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const INSTRUCTIONS_DISABLED = ["1", "true", "yes"].includes(
	(process.env.PI_COPILOT_INSTRUCTIONS_DISABLE ?? "").toLowerCase(),
);
const SKILLS_DISABLED = ["1", "true", "yes"].includes(
	(process.env.PI_COPILOT_SKILLS_DISABLE ?? "").toLowerCase(),
);
const BLOCK_START = "<github_copilot_instructions>";
const BLOCK_END = "</github_copilot_instructions>";
const REPOSITORY_INSTRUCTIONS = ".github/copilot-instructions.md";
const INSTRUCTIONS_DIR = ".github/instructions";
const SKILLS_DIR = ".github/skills";
const MAX_FILE_CHARS = 20_000;
const MAX_TOTAL_CHARS = 60_000;

interface InstructionFile {
	absPath: string;
	relPath: string;
	kind: "repository-wide" | "path-specific";
	body: string;
	applyTo?: string;
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

function extractApplyTo(frontmatter: string | undefined): string | undefined {
	if (!frontmatter) return undefined;

	const lines = frontmatter.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const match = /^applyTo:\s*(.*)$/.exec(lines[i]);
		if (!match) continue;

		const inline = match[1].trim();
		if (inline) return inline;

		const items: string[] = [];
		for (let j = i + 1; j < lines.length; j++) {
			const item = /^\s*-\s*(.+)$/.exec(lines[j]);
			if (item) {
				items.push(item[1].trim());
				continue;
			}
			if (/^\s*$/.test(lines[j])) continue;
			break;
		}
		return items.length > 0 ? items.join(", ") : undefined;
	}

	return undefined;
}

function truncateFile(content: string): string {
	if (content.length <= MAX_FILE_CHARS) return content;
	return `${content.slice(0, MAX_FILE_CHARS)}\n\n[truncated: GitHub Copilot instruction file exceeded ${MAX_FILE_CHARS} characters]`;
}

function readInstruction(absPath: string, root: string, kind: InstructionFile["kind"]): InstructionFile | undefined {
	const raw = readFileSync(absPath, "utf8");
	const parsed = splitFrontmatter(raw);
	if (!parsed.body) return undefined;

	return {
		absPath,
		relPath: relative(root, absPath).replace(/\\/g, "/"),
		kind,
		body: truncateFile(parsed.body),
		applyTo: extractApplyTo(parsed.frontmatter),
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
		file.applyTo ? `applyTo="${escapeAttribute(file.applyTo)}"` : undefined,
	]
		.filter(Boolean)
		.join(" ");

	return `<instruction ${attrs}>\n${file.body}\n</instruction>`;
}

function renderInstructions(files: InstructionFile[]): string {
	const header = [
		"GitHub Copilot instruction files discovered in this repository.",
		"Apply repository-wide instructions broadly. Apply path-specific instructions only when their applyTo patterns are relevant to the files being discussed or edited.",
		BLOCK_START,
	].join("\n");

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

export default function (pi: ExtensionAPI) {
	if (!SKILLS_DISABLED) {
		pi.on("resources_discover", async (event) => {
			const root = findProjectRoot(event.cwd);
			const skillsDir = join(root, SKILLS_DIR);
			return existsSync(skillsDir) ? { skillPaths: [skillsDir] } : {};
		});
	}

	if (INSTRUCTIONS_DISABLED) return;

	pi.on("before_agent_start", async (event, ctx) => {
		if (event.systemPrompt.includes(BLOCK_START)) return {};

		const root = findProjectRoot(ctx.cwd);
		const files = discoverInstructions(root);
		if (files.length === 0) return {};

		return {
			systemPrompt: `${event.systemPrompt}\n\n${renderInstructions(files)}`,
		};
	});
}
