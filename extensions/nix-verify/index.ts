/**
 * nix-verify — verification loop for Nix (.nix) files.
 *
 * Mirrors pi-lens's pattern for TS, but for Nix: on every edit/write of a
 * .nix file, run available Nix checkers (nix-instantiate --parse by default;
 * alejandra/nixpkgs-fmt/statix/deadnix if installed) and feed blocking
 * diagnostics back to the agent so it self-corrects.
 *
 * Disable with PI_NIX_VERIFY_DISABLE=1.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";

const DISABLED = ["1", "true", "yes"].includes(
	(process.env.PI_NIX_VERIFY_DISABLE ?? "").toLowerCase(),
);

interface CheckOutcome {
	ok: boolean;
	message: string;
}

interface Checker {
	id: string;
	label: string;
	check: (absPath: string) => CheckOutcome;
}

function run(
	cmd: string,
	args: string[],
	opts: { timeoutMs?: number; cwd?: string } = {},
) {
	const r = spawnSync(cmd, args, {
		encoding: "utf8",
		timeout: opts.timeoutMs ?? 30_000,
		cwd: opts.cwd,
	});
	return {
		code: r.status ?? -1,
		stdout: (r.stdout ?? "").toString().trim(),
		stderr: (r.stderr ?? "").toString().trim(),
	};
}

/** Walk up from a file path to find the nearest directory containing flake.nix. */
function findFlakeRoot(absPath: string): string | null {
	let dir = resolve(absPath);
	if (!existsSync(dir)) dir = resolve(dir, "..");
	for (let i = 0; i < 32; i++) {
		if (existsSync(join(dir, "flake.nix"))) return dir;
		const parent = resolve(dir, "..");
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

function hasCmd(cmd: string): boolean {
	return spawnSync("sh", ["-c", `command -v ${cmd} >/dev/null 2>&1`]).status === 0;
}

function firstLines(s: string, n = 8): string {
	return s.split("\n").slice(0, n).join("\n").trim();
}

function buildCheckers(): Checker[] {
	const out: Checker[] = [];
	if (hasCmd("nix-instantiate")) {
		out.push({
			id: "parse",
			label: "nix-instantiate --parse",
			check: (p) => {
				const r = run("nix-instantiate", ["--parse", p]);
				if (r.code === 0) return { ok: true, message: "" };
				return { ok: false, message: firstLines(r.stderr) || firstLines(r.stdout) || "syntax error" };
			},
		});
	}
	if (hasCmd("alejandra")) {
		out.push({
			id: "fmt",
			label: "alejandra --check",
			check: (p) => {
				const r = run("alejandra", ["--check", p]);
				return r.code === 0
					? { ok: true, message: "" }
					: { ok: false, message: "not formatted (run `alejandra <file>`)" };
			},
		});
	} else if (hasCmd("nixpkgs-fmt")) {
		out.push({
			id: "fmt",
			label: "nixpkgs-fmt --check",
			check: (p) => {
				const r = run("nixpkgs-fmt", ["--check", p]);
				return r.code === 0
					? { ok: true, message: "" }
					: { ok: false, message: "not formatted (run `nixpkgs-fmt <file>`)" };
			},
		});
	} else if (hasCmd("nix")) {
		// Fall back to the flake's own formatter (e.g. nixpkgs-fmt via `nix fmt`),
		// so format checks work in repos whose formatter is not on PATH.
		out.push({
			id: "fmt",
			label: "nix fmt -- --check",
			check: (p) => {
				const root = findFlakeRoot(p);
				if (!root) return { ok: true, message: "" };
				const r = run("nix", ["fmt", "--", "--check", p], { cwd: root, timeoutMs: 60_000 });
				// nix fmt prints a noisy "Git tree is dirty" warning to stderr; trust exit code.
				return r.code === 0
					? { ok: true, message: "" }
					: { ok: false, message: `not formatted (run \`nix fmt\` from the flake root)` };
			},
		});
	}
	if (hasCmd("statix")) {
		out.push({
			id: "statix",
			label: "statix check",
			check: (p) => {
				const r = run("statix", ["check", p]);
				return r.code === 0
					? { ok: true, message: "" }
					: { ok: false, message: firstLines(r.stdout) || firstLines(r.stderr) };
			},
		});
	}
	if (hasCmd("deadnix")) {
		out.push({
			id: "deadnix",
			label: "deadnix",
			check: (p) => {
				const r = run("deadnix", [p]);
				return r.code === 0 && !r.stdout
					? { ok: true, message: "" }
					: { ok: false, message: firstLines(r.stdout) || "unused bindings" };
			},
		});
	}
	return out;
}

const SKIP_DIRS = new Set([".git", "node_modules", ".pi", "result", "dist", "target", ".direnv"]);

function collectNixFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const e of entries) {
			const full = resolve(dir, e);
			let st;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				if (!SKIP_DIRS.has(e)) walk(full);
			} else if (e.endsWith(".nix")) {
				out.push(full);
			}
		}
	};
	walk(root);
	return out;
}

export default function (pi: ExtensionAPI) {
	const checkers = DISABLED ? [] : buildCheckers();

	pi.on("tool_result", async (event, ctx) => {
		if (checkers.length === 0) return;
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		if (event.isError) return;

		const input = (event as { input?: { path?: string } }).input;
		const p = input?.path;
		if (!p || !p.endsWith(".nix")) return;

		const abs = isAbsolute(p) ? p : resolve(ctx.cwd, p);
		if (!existsSync(abs)) return;

		const issues: string[] = [];
		for (const c of checkers) {
			const o = c.check(abs);
			if (!o.ok) issues.push(`[${c.label}]\n${o.message}`);
		}

		const rel = relative(ctx.cwd, abs) || abs;
		if (issues.length === 0) {
			return {
				content: [...event.content, { type: "text" as const, text: `✓ nix-verify: ${rel} clean` }],
			};
		}

		const block = [
			`🔴 STOP — nix-verify found ${issues.length} issue(s) in ${rel}:`,
			...issues.map((s, i) => `${i + 1}. ${s}`),
			"Fix the above before continuing.",
		].join("\n");
		return {
			content: [...event.content, { type: "text" as const, text: block }],
			isError: true,
		};
	});

	pi.registerCommand("nix-verify", {
		description: "Verify Nix files: parse-check all .nix (default) or eval the flake (--flake)",
		handler: async (args, ctx) => {
			if (checkers.length === 0) {
				ctx.ui.notify("nix-verify: no Nix tooling found (install nix-instantiate)", "warning");
				return;
			}

			// /nix-verify --flake : whole-flake eval check (read-only, no build).
			// Catches eval errors that --parse cannot (undefined attrs, type errors,
			// stale flake.lock inputs). Slower, so on-demand only.
			if (args?.includes("--flake")) {
				if (!existsSync(join(ctx.cwd, "flake.nix"))) {
					ctx.ui.notify("nix-verify --flake: no flake.nix in cwd", "warning");
					return;
				}
				ctx.ui.notify("nix-verify: running `nix flake check --no-build`...", "info");
				const r = run("nix", ["flake", "check", "--no-build"], { cwd: ctx.cwd, timeoutMs: 180_000 });
				if (r.code === 0) {
					ctx.ui.notify("✓ nix-verify: flake eval clean", "info");
				} else {
					ctx.ui.notify("🔴 nix-verify: flake eval failed", "error");
					ctx.ui.setWidget("nix-verify", ["`nix flake check --no-build` failed:", "", firstLines(r.stderr || r.stdout, 40)]);
				}
				return;
			}

			const parse = checkers.find((c) => c.id === "parse") ?? checkers[0];
			const files = collectNixFiles(ctx.cwd);
			if (files.length === 0) {
				ctx.ui.notify("nix-verify: no .nix files found", "info");
				return;
			}
			const failed: string[] = [];
			for (const f of files) {
				const o = parse.check(f);
				if (!o.ok) failed.push(`${relative(ctx.cwd, f) || f}:\n${o.message}`);
			}
			if (failed.length === 0) {
				ctx.ui.notify(`✓ nix-verify: ${files.length} .nix files parse clean`, "info");
			} else {
				ctx.ui.notify(`🔴 nix-verify: ${failed.length}/${files.length} .nix files have issues`, "error");
				ctx.ui.setWidget("nix-verify", ["nix-verify results:", "", ...failed]);
			}
		},
	});
}