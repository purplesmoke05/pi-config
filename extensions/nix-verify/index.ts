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
import { isAbsolute, relative, resolve } from "node:path";

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

function run(cmd: string, args: string[], timeoutMs = 30_000) {
	const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs });
	return {
		code: r.status ?? -1,
		stdout: (r.stdout ?? "").toString().trim(),
		stderr: (r.stderr ?? "").toString().trim(),
	};
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
		description: "Parse-check all .nix files under cwd for syntax errors",
		handler: async (_args, ctx) => {
			if (checkers.length === 0) {
				ctx.ui.notify("nix-verify: no Nix tooling found (install nix-instantiate)", "warning");
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