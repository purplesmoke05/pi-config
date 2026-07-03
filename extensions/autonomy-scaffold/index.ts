/**
 * autonomy-scaffold -- keeps weak-autonomy models on task.
 *
 * Targets two failure modes:
 *  1. Premature stopping: declaring "done" or asking the user before the work
 *     is verifiably complete.
 *  2. Tool forgetting: asking the user for information the agent could look up
 *     itself with ls/find/grep/read/bash.
 *
 * On every agent start, appends a short discipline block to the system prompt.
 * Idempotent (guarded by block markers).
 *
 * Disabled by default. Enable at pi launch with
 * PI_AUTONOMY_SCAFFOLD_ENABLE=1 (also accepts true/yes). When enabled, the
 * scaffold applies to all models unless PI_AUTONOMY_SCAFFOLD_ONLY narrows it:
 * a comma-separated list matched as case-insensitive substrings against the
 * model id and provider (e.g. PI_AUTONOMY_SCAFFOLD_ONLY=glm,qwen-coder,llama).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ENABLED = ["1", "true", "yes"].includes(
	(process.env.PI_AUTONOMY_SCAFFOLD_ENABLE ?? "").toLowerCase(),
);

const ONLY_RAW = (process.env.PI_AUTONOMY_SCAFFOLD_ONLY ?? "").trim();
const ONLY_PATTERNS = ONLY_RAW
	? ONLY_RAW.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
	: [];

const BLOCK_START = "<autonomy_scaffold>";
const BLOCK_END = "</autonomy_scaffold>";

const SCAFFOLD = [
	BLOCK_START,
	"You are operating in an autonomous coding session. Follow these disciplines:",
	"",
	"Stay on task until the work is verifiably done. Do not stop to ask the user for",
	"permission to take an action you can take yourself, and do not declare the task",
	"complete until you have verified the result -- re-read edited files, run the",
	"relevant checks or tests, and confirm the original goal is met. If a step fails,",
	"diagnose the cause and try a different approach instead of stopping or asking.",
	"",
	"Investigate before you ask. Before asking the user a question, check whether you",
	"can answer it with your own tools (ls, find, grep, read, bash). Look up file",
	"contents, directory structure, error messages, and configuration yourself. Only",
	"ask the user about information that is genuinely outside the workspace.",
	BLOCK_END,
].join("\n");

function shouldApply(model: { id: string; provider: string } | undefined): boolean {
	if (ONLY_PATTERNS.length === 0) return true;
	if (!model) return false;
	const hay = `${model.id} ${model.provider}`.toLowerCase();
	return ONLY_PATTERNS.some((p) => hay.includes(p));
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		if (!ENABLED) return {};
		if (event.systemPrompt.includes(BLOCK_START)) return {};
		if (!shouldApply(ctx.model as { id: string; provider: string } | undefined)) return {};

		return {
			systemPrompt: `${event.systemPrompt}\n\n${SCAFFOLD}`,
		};
	});

	pi.registerCommand("autonomy-scaffold", {
		description: "Show whether the autonomy scaffold is active for the current model",
		handler: async (_args, ctx) => {
			if (!ENABLED) {
				ctx.ui.notify("autonomy-scaffold: disabled (set PI_AUTONOMY_SCAFFOLD_ENABLE=1)", "warning");
				return;
			}
			const model = ctx.model as { id: string; provider: string } | undefined;
			const applies = shouldApply(model);
			const scope = ONLY_PATTERNS.length
				? `only for models matching: ${ONLY_PATTERNS.join(", ")}`
				: "all models";
			if (applies) {
				ctx.ui.notify(`autonomy-scaffold: active (${scope})`, "info");
			} else {
				ctx.ui.notify(
					`autonomy-scaffold: not applied to ${model?.id ?? "no model"} (${scope})`,
					"warning",
				);
			}
		},
	});
}
