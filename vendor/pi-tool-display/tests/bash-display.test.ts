import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { truncateCommandDisplay } from "../src/bash-display.ts";

describe("bash command display truncation", () => {
  it("leaves short commands unchanged", () => {
    assert.equal(truncateCommandDisplay("npm test", 120), "npm test");
  });

  it("truncates to the configured character budget", () => {
    assert.equal(truncateCommandDisplay("abcdefghij", 6), "abcde…");
  });

  it("counts Unicode code points rather than UTF-16 units", () => {
    assert.equal(truncateCommandDisplay("echo 🟣🟣🟣🟣", 8), "echo 🟣🟣…");
  });

  it("treats zero or a missing value as unlimited", () => {
    assert.equal(truncateCommandDisplay("abcdefghij", 0), "abcdefghij");
    assert.equal(truncateCommandDisplay("abcdefghij", undefined), "abcdefghij");
  });
});
