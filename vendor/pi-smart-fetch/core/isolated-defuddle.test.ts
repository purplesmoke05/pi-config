import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { extractDefuddleInWorker } from "./isolated-defuddle.ts";

test("isolated Defuddle extracts ordinary HTML", async () => {
  const extracted = await extractDefuddleInWorker(
    "<html><head><title>Example</title></head><body><main><p>A readable article with several useful words.</p></main></body></html>",
    "https://example.com/article",
    { markdown: true, removeImages: true },
    AbortSignal.timeout(5_000),
  );

  assert.match(extracted.content ?? "", /readable article/i);
});

test("isolated Defuddle can be terminated at the operation deadline", async () => {
  const startedAt = performance.now();
  await assert.rejects(
    extractDefuddleInWorker(
      "<div>".repeat(13_107),
      "https://example.com/pathological",
      { markdown: true, removeImages: true },
      AbortSignal.timeout(30),
    ),
    /timed out|abort/i,
  );
  assert.ok(performance.now() - startedAt < 1_000);
});
