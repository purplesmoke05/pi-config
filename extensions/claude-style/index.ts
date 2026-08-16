/**
 * claude-style — small visual tweaks that make pi's streaming indicator feel
 * closer to Claude Code's TUI.
 *
 * The only thing this extension changes is the inline working-indicator spinner
 * (the animated glyph shown while pi streams a response). Claude Code uses a
 * braille-dot spinner, so we swap pi's default frames for that set, colored
 * with the active theme's `accent` token so it adapts to whatever theme is
 * selected (here: catppuccin-mocha).
 *
 * This composes cleanly with `pi-powerline-footer`, which controls the working
 * *message* text ("Working…", vibe themes, etc.) via `ctx.ui.setWorkingMessage`.
 * `setWorkingIndicator` only replaces the spinner glyph frames, so both
 * extensions can stay active at the same time without one clobbering the other.
 *
 * `setWorkingIndicator` is TUI-only; in RPC/print/JSON modes it is a no-op, so
 * we guard on `ctx.mode === "tui"`.
 *
 * Disable with PI_CLAUDE_STYLE_DISABLE=1.
 */

import type {
	ExtensionAPI,
	ExtensionUIContext,
	WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";

const DISABLED = ["1", "true", "yes"].includes(
	(process.env.PI_CLAUDE_STYLE_DISABLE ?? "").toLowerCase(),
);

// Standard braille spinner, the same frame sequence Claude Code's TUI uses.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

function buildIndicator(ui: ExtensionUIContext): WorkingIndicatorOptions {
	// Custom frames are rendered verbatim, so we color them with the active
	// theme's accent token. This keeps the spinner coherent with catppuccin
	// (or any other selected theme) instead of baking in a fixed RGB.
	const frames = SPINNER_FRAMES.map((frame) => ui.theme.fg("accent", frame));
	return { frames, intervalMs: SPINNER_INTERVAL_MS };
}

export default function claudeStyleExtension(pi: ExtensionAPI): void {
	if (DISABLED) return;

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWorkingIndicator(buildIndicator(ctx.ui));
	});
}
