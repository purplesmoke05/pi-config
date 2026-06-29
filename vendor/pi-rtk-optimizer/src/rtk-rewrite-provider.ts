import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveRtkExecutable, type RtkExecutableResolution } from "./rtk-executable-resolver.js";
import { splitLeadingEnvAssignments } from "./shell-env-prefix.js";

export interface RtkRewriteProviderResult {
	changed: boolean;
	originalCommand: string;
	rewrittenCommand: string;
	exitCode: number;
	error?: string;
	executableResolution?: RtkExecutableResolution;
}

export interface RtkRewriteProviderOptions {
	timeoutMs?: number;
	resolverTimeoutMs?: number;
	platform?: typeof process.platform;
	executableResolution?: RtkExecutableResolution;
}

function isAlreadyRtk(command: string): boolean {
	const trimmed = command.trimStart();
	return trimmed === "rtk" || trimmed.startsWith("rtk ");
}

function normalizeOptions(optionsOrTimeout: number | RtkRewriteProviderOptions): RtkRewriteProviderOptions {
	if (typeof optionsOrTimeout === "number") {
		return { timeoutMs: optionsOrTimeout };
	}
	return optionsOrTimeout;
}

interface ShellSegmentSplit {
	segments: string[];
	separators: string[];
}

function splitTopLevelShellSegments(command: string): ShellSegmentSplit {
	const segments: string[] = [];
	const separators: string[] = [];
	let quote: '"' | "'" | "`" | null = null;
	let escaped = false;
	let segmentStart = 0;

	for (let index = 0; index < command.length; index += 1) {
		const character = command[index] ?? "";
		const nextCharacter = command[index + 1] ?? "";
		const previousCharacter = index > 0 ? (command[index - 1] ?? "") : "";

		if (escaped) {
			escaped = false;
			continue;
		}

		if (quote !== null) {
			if (character === "\\" && quote !== "'") {
				escaped = true;
				continue;
			}
			if (character === quote) {
				quote = null;
			}
			continue;
		}

		if (character === "\\") {
			escaped = true;
			continue;
		}

		if (character === '"' || character === "'" || character === "`") {
			quote = character;
			continue;
		}

		const twoCharacterOperator = `${character}${nextCharacter}`;
		const separator =
			twoCharacterOperator === "&&" || twoCharacterOperator === "||" || twoCharacterOperator === "|&"
				? twoCharacterOperator
				: character === ";" || (character === "|" && previousCharacter !== ">")
					? character
					: null;

		if (separator === null) {
			continue;
		}

		segments.push(command.slice(segmentStart, index));
		separators.push(separator);
		index += separator.length - 1;
		segmentStart = index + 1;
	}

	segments.push(command.slice(segmentStart));
	return { segments, separators };
}

function startsWithRipgrepCommand(segment: string): boolean {
	const trimmed = segment.trimStart();
	const effectiveCommand = splitLeadingEnvAssignments(trimmed).command.trimStart();
	return /^rg(?=\s|$)/u.test(effectiveCommand);
}

function replaceRtkGrepProxyWithRtkRg(segment: string): string {
	const leadingWhitespace = segment.match(/^\s*/u)?.[0] ?? "";
	const withoutLeadingWhitespace = segment.slice(leadingWhitespace.length);
	const { envPrefix, command } = splitLeadingEnvAssignments(withoutLeadingWhitespace);
	const nextCommand = command.replace(/^(rtk)(\s+)grep(?=\s|$)/u, "$1$2rg");
	return nextCommand === command ? segment : `${leadingWhitespace}${envPrefix}${nextCommand}`;
}

function normalizeRipgrepRewrite(originalCommand: string, rewrittenCommand: string): string {
	const original = splitTopLevelShellSegments(originalCommand);
	const rewritten = splitTopLevelShellSegments(rewrittenCommand);
	if (original.segments.length !== rewritten.segments.length) {
		return rewrittenCommand;
	}

	let changed = false;
	const rewrittenSegments = rewritten.segments.map((segment, index) => {
		if (!startsWithRipgrepCommand(original.segments[index] ?? "")) {
			return segment;
		}

		const nextSegment = replaceRtkGrepProxyWithRtkRg(segment);
		changed ||= nextSegment !== segment;
		return nextSegment;
	});

	if (!changed) {
		return rewrittenCommand;
	}

	return rewrittenSegments.reduce((accumulator, segment, index) => {
		const separator = rewritten.separators[index - 1];
		return separator === undefined ? segment : `${accumulator}${separator}${segment}`;
	}, "");
}

export async function resolveRtkRewrite(
	pi: ExtensionAPI,
	command: string,
	optionsOrTimeout: number | RtkRewriteProviderOptions = {},
): Promise<RtkRewriteProviderResult> {
	const options = normalizeOptions(optionsOrTimeout);
	const timeoutMs = options.timeoutMs ?? 3000;

	if (!command || !command.trim()) {
		return { changed: false, originalCommand: command, rewrittenCommand: command, exitCode: 1 };
	}

	if (isAlreadyRtk(command)) {
		return { changed: false, originalCommand: command, rewrittenCommand: command, exitCode: 1 };
	}

	try {
		const executableResolution =
			options.executableResolution ??
			(await resolveRtkExecutable(pi, {
				platform: options.platform,
				timeoutMs: options.resolverTimeoutMs,
			}));
		const result = await pi.exec(executableResolution.command, ["rewrite", command], { timeout: timeoutMs });

		if (result.code === 1) {
			return {
				changed: false,
				originalCommand: command,
				rewrittenCommand: command,
				exitCode: 1,
				executableResolution,
			};
		}

		if (result.code === 2) {
			return {
				changed: false,
				originalCommand: command,
				rewrittenCommand: command,
				exitCode: 2,
				error: result.stderr?.trim() || "rtk denied rewrite",
				executableResolution,
			};
		}

		if (result.code === 0 || result.code === 3) {
			const rewrittenOutput = result.stdout?.trim();
			if (!rewrittenOutput) {
				return {
					changed: false,
					originalCommand: command,
					rewrittenCommand: command,
					exitCode: result.code,
					error: "rtk returned empty output",
					executableResolution,
				};
			}
			const rewritten = normalizeRipgrepRewrite(command, rewrittenOutput);
			if (rewritten === command) {
				return {
					changed: false,
					originalCommand: command,
					rewrittenCommand: command,
					exitCode: result.code,
					executableResolution,
				};
			}
			return {
				changed: true,
				originalCommand: command,
				rewrittenCommand: rewritten,
				exitCode: result.code,
				executableResolution,
			};
		}

		return {
			changed: false,
			originalCommand: command,
			rewrittenCommand: command,
			exitCode: result.code,
			error: `unexpected exit code ${result.code}`,
			executableResolution,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			changed: false,
			originalCommand: command,
			rewrittenCommand: command,
			exitCode: -1,
			error: message,
		};
	}
}
