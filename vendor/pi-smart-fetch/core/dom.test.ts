import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_HTML_ELEMENTS,
  MAX_HTML_NESTING_DEPTH,
  assertHtmlWithinComplexityLimits,
} from "./dom.ts";

test("HTML complexity limits reject excessive nesting", () => {
  const nested = "<div>".repeat(MAX_HTML_NESTING_DEPTH + 1);
  assert.throws(
    () => assertHtmlWithinComplexityLimits(nested),
    /nesting limit/i,
  );
});

test("HTML complexity limits treat non-void self-closing syntax as nested", () => {
  const nested = "<div/>".repeat(MAX_HTML_NESTING_DEPTH + 1);
  assert.throws(
    () => assertHtmlWithinComplexityLimits(nested),
    /nesting limit/i,
  );
});

test("HTML complexity limits reject excessive element counts", () => {
  const elements = "<br>".repeat(MAX_HTML_ELEMENTS + 1);
  assert.throws(
    () => assertHtmlWithinComplexityLimits(elements),
    /element limit/i,
  );
});

test("HTML complexity scan ignores raw text and comments", () => {
  const fakeTags = "<div>".repeat(MAX_HTML_NESTING_DEPTH + 1);
  assert.doesNotThrow(() =>
    assertHtmlWithinComplexityLimits(
      `<script>const template = ${JSON.stringify(fakeTags)}</script><!--${fakeTags}-->`,
    ),
  );
});
