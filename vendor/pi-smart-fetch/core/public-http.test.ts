import assert from "node:assert/strict";
import test from "node:test";
import {
  NonTextResponseError,
  safeFetchText,
  type PublicFetch,
} from "./public-http.ts";
import type { FetchResponseLike, ReadableBodyStream } from "./types.ts";

function response(
  contentType: string | null,
  body = "hello",
): { value: FetchResponseLike; canceled: () => boolean } {
  let wasCanceled = false;
  const stream: ReadableBodyStream<Uint8Array> = {
    locked: false,
    getReader() {
      return {
        async read() {
          return { done: true };
        },
        async cancel() {
          wasCanceled = true;
        },
        releaseLock() {},
      };
    },
  };
  return {
    canceled: () => wasCanceled,
    value: {
      ok: true,
      status: 200,
      statusText: "OK",
      url: "https://example.com/final",
      headers: { get: (name) => (name.toLowerCase() === "content-type" ? contentType : null) },
      body: stream,
      async text() {
        return body;
      },
      async arrayBuffer() {
        return new ArrayBuffer(0);
      },
      readable() {
        throw new Error("not used");
      },
    },
  };
}

test("safeFetchText forwards mandatory limits and returns the final URL", async () => {
  const mock = response("text/html; charset=utf-8", "<p>ok</p>");
  let seenOptions: Record<string, unknown> | undefined;
  const fetchImpl: PublicFetch = async (_url, options) => {
    seenOptions = options;
    return mock.value;
  };

  const result = await safeFetchText(
    "https://example.com/start",
    {
      timeoutMs: 1_500,
      maxBytes: 4_096,
      redirect: "follow",
      contentTypes: "textual",
      headers: { Accept: "text/html" },
    },
    fetchImpl,
  );

  assert.equal(result.url, "https://example.com/final");
  assert.equal(result.body, "<p>ok</p>");
  assert.equal(seenOptions?.timeoutMs, 1_500);
  assert.equal(seenOptions?.maxBytes, 4_096);
  assert.equal(seenOptions?.redirect, "follow");
});

test("safeFetchText rejects and cancels non-text responses", async () => {
  const mock = response("application/octet-stream");
  await assert.rejects(
    safeFetchText(
      "https://example.com/file",
      { timeoutMs: 1_500, maxBytes: 4_096, redirect: "error", contentTypes: "textual" },
      async () => mock.value,
    ),
    NonTextResponseError,
  );
  assert.equal(mock.canceled(), true);
});

test("safeFetchText rejects missing content type and invalid limits", async () => {
  const mock = response(null);
  await assert.rejects(
    safeFetchText(
      "https://example.com/no-type",
      { timeoutMs: 1_500, maxBytes: 4_096, redirect: "error", contentTypes: "textual" },
      async () => mock.value,
    ),
    NonTextResponseError,
  );
  await assert.rejects(
    safeFetchText(
      "https://example.com",
      { timeoutMs: 0, maxBytes: 4_096, redirect: "error", contentTypes: "textual" },
      async () => mock.value,
    ),
    /timeoutMs must be a positive finite number/,
  );
});

test("safeFetchText blocks private-network targets through the real boundary", async () => {
  await assert.rejects(
    safeFetchText("http://127.0.0.1/", {
      timeoutMs: 1_500,
      maxBytes: 4_096,
      redirect: "error",
      contentTypes: "textual",
    }),
    /public|private|local|blocked/i,
  );
});
