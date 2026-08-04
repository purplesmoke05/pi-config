import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveExternalEditorCommand } from "./external-editor.ts";

test("VISUAL takes precedence over EDITOR", () => {
	assert.equal(resolveExternalEditorCommand({ VISUAL: "nvim", EDITOR: "vim" }), "nvim");
});

test("EDITOR is used when VISUAL is empty", () => {
	assert.equal(resolveExternalEditorCommand({ VISUAL: "  ", EDITOR: "code --wait" }), "code --wait");
});

test("missing editor configuration is explicit", () => {
	assert.equal(resolveExternalEditorCommand({}), undefined);
});
