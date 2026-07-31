import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { BUNDLED_SUCCESS_SOUND_FILE, resolveLinuxSoundCommand } from "./index.ts";

describe("Linux notification sound selection", () => {
	it("ships the bundled completion sound", () => {
		const header = readFileSync(BUNDLED_SUCCESS_SOUND_FILE).subarray(0, 12);
		assert.equal(header.toString("ascii", 0, 4), "RIFF");
		assert.equal(header.toString("ascii", 8, 12), "WAVE");
	});

	it("prefers the bundled sound through pw-play for successful runs", () => {
		const commands = new Set(["pw-play", "canberra-gtk-play"]);
		const selected = resolveLinuxSoundCommand(
			"success",
			(command) => commands.has(command),
			(file) => file === BUNDLED_SUCCESS_SOUND_FILE,
		);

		assert.deepEqual(selected, {
			command: "pw-play",
			args: [BUNDLED_SUCCESS_SOUND_FILE],
		});
	});

	it("uses paplay for the bundled sound when pw-play is unavailable", () => {
		const selected = resolveLinuxSoundCommand(
			"success",
			(command) => command === "paplay",
			(file) => file === BUNDLED_SUCCESS_SOUND_FILE,
		);

		assert.deepEqual(selected, {
			command: "paplay",
			args: [BUNDLED_SUCCESS_SOUND_FILE],
		});
	});

	it("keeps the existing event sound for errors", () => {
		const commands = new Set(["pw-play", "canberra-gtk-play"]);
		const selected = resolveLinuxSoundCommand(
			"error",
			(command) => commands.has(command),
			() => true,
		);

		assert.deepEqual(selected, {
			command: "canberra-gtk-play",
			args: ["-i", "complete"],
		});
	});

	it("keeps the freedesktop fallback when the bundled sound cannot be played", () => {
		const selected = resolveLinuxSoundCommand(
			"success",
			(command) => command === "paplay",
			(file) => file.endsWith("/message.oga"),
		);

		assert.deepEqual(selected, {
			command: "paplay",
			args: ["/usr/share/sounds/freedesktop/stereo/message.oga"],
		});
	});
});
