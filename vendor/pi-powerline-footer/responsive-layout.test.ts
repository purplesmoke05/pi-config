import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { partitionResponsiveSegments } from "./responsive-layout.ts";

describe("powerline responsive layout", () => {
  it("prioritizes declared secondary status content after top-row overflow", () => {
    const result = partitionResponsiveSegments(
      [
        { content: "model", width: 20, secondary: false },
        { content: "path", width: 30, secondary: false },
        { content: "git", width: 30, secondary: false },
        { content: "Codex wk 11% left", width: 20, secondary: true },
      ],
      60,
      3,
    );

    assert.deepEqual(result.top, ["model", "path"]);
    assert.deepEqual(result.secondary, ["Codex wk 11% left", "git"]);
  });

  it("keeps the first independent status when later statuses do not fit", () => {
    const result = partitionResponsiveSegments(
      [
        { content: "model", width: 40, secondary: false },
        { content: "Codex wk 11% left", width: 20, secondary: true },
        { content: "OpenAI cache statistics", width: 35, secondary: true },
      ],
      50,
      3,
    );

    assert.deepEqual(result.top, ["model"]);
    assert.deepEqual(result.secondary, ["Codex wk 11% left"]);
  });

  it("moves secondary content onto the top row when everything fits", () => {
    const result = partitionResponsiveSegments(
      [
        { content: "model", width: 10, secondary: false },
        { content: "quota", width: 10, secondary: true },
      ],
      40,
      3,
    );

    assert.deepEqual(result, { top: ["model", "quota"], secondary: [] });
  });

  it("retains primary overflow order after prioritized secondary content", () => {
    const result = partitionResponsiveSegments(
      [
        { content: "model", width: 15, secondary: false },
        { content: "path", width: 15, secondary: false },
        { content: "git", width: 15, secondary: false },
        { content: "status", width: 10, secondary: true },
      ],
      35,
      2,
    );

    assert.deepEqual(result.top, ["model", "path"]);
    assert.deepEqual(result.secondary, ["status", "git"]);
  });
});
