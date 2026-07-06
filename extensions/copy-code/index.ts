/**
 * copy-code — copy a fenced code block from the last assistant message to the
 * clipboard as raw text, bypassing the gutter indent pi's TUI bakes into
 * mouse-selected output.
 *
 * pi renders code blocks with a per-line prefix (`codeBlockIndent`, default 2
 * spaces) plus a 1-space `paddingX` left margin, both as literal characters in
 * the line string. Terminal mouse selection therefore copies that leading
 * whitespace on every line. This extension grabs the raw (pre-render) assistant
 * text instead and copies just the requested fenced block.
 *
 *   /copy-code         copy the LAST code block
 *   /copy-code 2       copy the Nth block (1-based)
 *   /copy-code all     copy every block, concatenated as fenced markdown
 *   /copy-code list    show a numbered list of blocks (no copy)
 *   /cc                alias for /copy-code
 *
 * Disable with PI_COPY_CODE_DISABLE=1.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import { copyToClipboard, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const DISABLED = ["1", "true", "yes"].includes(
	(process.env.PI_COPY_CODE_DISABLE ?? "").toLowerCase(),
);

interface CodeBlock {
	lang: string;
	body: string;
}

// Matches ```lang\n...``` fenced blocks. Non-greedy body so each block stops at
// its own closing fence. A leading language label of anything-but-newline/backtick
// keeps `ts`, `c++`, `python3`, etc. without spanning into the body.
const FENCE_RE = /```([^\n`]*)\n([\s\S]*?)```/g;

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant" && Array.isArray(message.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function extractCodeBlocks(text: string): CodeBlock[] {
	const blocks: CodeBlock[] = [];
	for (const match of text.matchAll(FENCE_RE)) {
		blocks.push({ lang: (match[1] ?? "").trim(), body: match[2] ?? "" });
	}
	return blocks;
}

function lineCount(s: string): number {
	if (!s) return 0;
	return s.split("\n").length;
}

function previewLine(s: string, max = 56): string {
	const line = s.split("\n").find((l) => l.trim() !== "") ?? "";
	if (!line) return "(empty)";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function formatAll(blocks: CodeBlock[]): string {
	return blocks
		.map((b) => {
			const body = b.body.endsWith("\n") ? b.body : `${b.body}\n`;
			return "```" + (b.lang || "") + "\n" + body + "```";
		})
		.join("\n\n");
}

export default function copyCodeExtension(pi: ExtensionAPI): void {
	if (DISABLED) return;

	// Latest assistant text content. Kept as a single slot (overwritten each
	// assistant message_end) so memory never grows with conversation length.
	let lastText: string | null = null;

	pi.on("message_end", async (event) => {
		if (isAssistantMessage(event.message)) {
			lastText = getTextContent(event.message);
		}
	});

	async function copyAndNotify(
		blocks: CodeBlock[],
		idx: number | "all",
		ctx: ExtensionCommandContext,
	): Promise<void> {
		if (blocks.length === 0) {
			ctx.ui.notify("copy-code: no code blocks in the last assistant message", "warning");
			return;
		}

		let text: string;
		let label: string;
		if (idx === "all") {
			text = formatAll(blocks);
			label = `all ${blocks.length} block${blocks.length === 1 ? "" : "s"} · ${lineCount(text)} lines`;
		} else {
			const i = idx - 1;
			if (i < 0 || i >= blocks.length) {
				ctx.ui.notify(`copy-code: index ${idx} out of range (have ${blocks.length})`, "warning");
				return;
			}
			const b = blocks[i];
			text = b.body;
			label = `block ${idx}/${blocks.length}${b.lang ? ` · ${b.lang}` : ""} · ${lineCount(b.body)} lines`;
		}

		try {
			await copyToClipboard(text);
			ctx.ui.notify(`copy-code: copied ${label}`, "info");
		} catch (err) {
			ctx.ui.notify(`copy-code: clipboard write failed — ${String(err)}`, "error");
		}
	}

	const handler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		const blocks = extractCodeBlocks(lastText ?? "");
		const arg = (args ?? "").trim().toLowerCase();

		if (arg === "list") {
			if (blocks.length === 0) {
				ctx.ui.notify("copy-code: no code blocks in the last assistant message", "warning");
				return;
			}
			ctx.ui.setWidget("copy-code", [
				`copy-code: ${blocks.length} block${blocks.length === 1 ? "" : "s"} in the last message`,
				"",
				...blocks.map(
					(b, i) =>
						`${i + 1}. [${b.lang || "•"}] ${lineCount(b.body)} lines  ${previewLine(b.body)}`,
				),
				"",
				"usage: /copy-code [n|all|list]",
			]);
			return;
		}

		if (arg === "all") {
			await copyAndNotify(blocks, "all", ctx);
			return;
		}

		if (arg === "" ) {
			await copyAndNotify(blocks, blocks.length, ctx); // last
			return;
		}

		const n = Number.parseInt(arg, 10);
		if (Number.isFinite(n) && n > 0) {
			await copyAndNotify(blocks, n, ctx);
			return;
		}

		ctx.ui.notify("copy-code: usage /copy-code [n|all|list]", "warning");
	};

	pi.registerCommand("copy-code", {
		description: "Copy a fenced code block from the last answer to the clipboard: /copy-code [n|all|list]",
		handler,
	});
	pi.registerCommand("cc", {
		description: "Alias for /copy-code",
		handler,
	});
}