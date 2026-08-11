import assert from "node:assert/strict";
import test from "node:test";
import {
	cleanStepText,
	extractDoneSteps,
	extractTodoItems,
	isSafeCommand,
	markCompletedSteps,
} from "./utils.ts";

test("isSafeCommand allows read-only commands", () => {
	assert.equal(isSafeCommand("cat package.json"), true);
	assert.equal(isSafeCommand("ls -la"), true);
	assert.equal(isSafeCommand("grep -n todo src/index.ts"), true);
	assert.equal(isSafeCommand("git status"), true);
	assert.equal(isSafeCommand("git diff --stat"), true);
	assert.equal(isSafeCommand("curl -s https://example.com"), true);
	assert.equal(isSafeCommand("npm list --depth=0"), true);
});

test("isSafeCommand blocks destructive and write commands", () => {
	assert.equal(isSafeCommand("rm -rf node_modules"), false);
	assert.equal(isSafeCommand("mv a b"), false);
	assert.equal(isSafeCommand("cp a b"), false);
	assert.equal(isSafeCommand("touch file"), false);
	assert.equal(isSafeCommand("chmod +x script.sh"), false);
	assert.equal(isSafeCommand("git add ."), false);
	assert.equal(isSafeCommand("git commit -m x"), false);
	assert.equal(isSafeCommand("npm install"), false);
	assert.equal(isSafeCommand("sudo apt update"), false);
	assert.equal(isSafeCommand("vim src/index.ts"), false);
	assert.equal(isSafeCommand("echo x > file"), false);
});

test("isSafeCommand blocks multi-command and redirected shells", () => {
	assert.equal(isSafeCommand("cat a; rm -rf ."), false);
	assert.equal(isSafeCommand("cat a | rm -rf ."), false);
	assert.equal(isSafeCommand("cat a > out.txt"), false);
});

test("extractTodoItems parses a numbered Plan: section", () => {
	const items = extractTodoItems(
		[
			"Let me analyze the code.",
			"",
			"Plan:",
			"1. Read the entry point",
			"2. Trace the data flow",
			"3. **Document the findings**",
			"",
			"Then I will stop.",
		].join("\n"),
	);
	assert.equal(items.length, 3);
	assert.equal(items[0].step, 1);
	assert.equal(items[0].text, "Entry point"); // leading verb stripped by cleanStepText
	assert.equal(items[1].step, 2);
	assert.equal(items[1].text, "Trace the data flow"); // "Trace" is not a stripped verb
	assert.equal(items[2].text, "Document the findings"); // bold markers stripped
	assert.equal(items.every((t) => t.completed === false), true);
});

test("extractTodoItems ignores sections without a Plan: header and short/noise lines", () => {
	assert.deepEqual(extractTodoItems("Just a summary, no plan."), []);
	const items = extractTodoItems("Plan:\n1. x\n2. - a bullet\n3. `code`\n4. Run the thing\n");
	// "x" too short, bullet and code fence skipped, verb-prefixed step cleaned.
	assert.equal(items.length, 1);
	assert.equal(items[0].step, 1);
	assert.equal(items[0].text, "Thing");
});

test("extractDoneSteps parses [DONE:n] markers", () => {
	assert.deepEqual(extractDoneSteps("Step [DONE:1] finished, also [DONE:3]."), [1, 3]);
	assert.deepEqual(extractDoneSteps("no markers"), []);
});

test("markCompletedSteps marks matching todo items", () => {
	const items = extractTodoItems("Plan:\n1. Inspect the entry point\n2. Trace the data flow\n");
	assert.equal(items.length, 2);
	markCompletedSteps("Finished [DONE:1]", items);
	assert.equal(items[0].completed, true);
	assert.equal(items[1].completed, false);
});

test("cleanStepText strips formatting and leading verbs and truncates", () => {
	assert.equal(cleanStepText("**Refactor the module**"), "Refactor the module");
	assert.equal(cleanStepText("`npm run build`"), "Npm run build"); // code stripped, then first char capitalized
	assert.equal(cleanStepText("Run the tests"), "Tests"); // leading "Run the " stripped, then capitalized
	const long = cleanStepText("Implement a very long step description that exceeds the fifty character display limit");
	assert.equal(long.length, 50);
	assert.match(long, /\.\.\.$/);
});
