import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import {
  MAX_SEARCH_BODY_BYTES,
  buildSearchUrl,
  fetchReadablePage,
  renderProgressCard,
} from "./index.ts";
import type { FetchResponseLike } from "../pi-smart-fetch/core/types.ts";

function responseFixture(options: {
  status?: number;
  url?: string;
  body?: string;
  headers?: Record<string, string>;
  onCancel?: () => void;
  keepOpen?: boolean;
} = {}): FetchResponseLike {
  const bodyText = options.body ?? "";
  const bytes = new TextEncoder().encode(bodyText);
  const headers = new Map(
    Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      if (!options.keepOpen) controller.close();
    },
    cancel() {
      options.onCancel?.();
    },
  });

  const status = options.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Redirect",
    url: options.url ?? "https://html.duckduckgo.com/html/?q=test",
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    body: stream,
    text: async () => bodyText,
    arrayBuffer: async () => bytes.buffer.slice(0),
    readable: () => Readable.from([bytes]),
  };
}

const noWait = async () => {};
const allowPublic = async (url: string) => new URL(url).href;

describe("hardened DuckDuckGo transport", () => {
  it("strips terminal controls and line breaks from progress queries", () => {
    const rendered = renderProgressCard(
      [
        {
          query: "safe\u001b]52;c;x\u0007\nforged\u009b31m",
          status: "loading",
          result: undefined,
        },
      ],
      {
        fg: (_color: string, value: string) => value,
        bold: (value: string) => value,
      },
      80,
    );

    assert.doesNotMatch(rendered, /[\u001b\u0007\u009b]/);
    assert.doesNotMatch(rendered, /\nforged/);
    assert.match(rendered, /safe�]52;c;x� forged�31m/);
  });

  it("encodes URL-shaped query text into the fixed endpoint", () => {
    const built = new URL(buildSearchUrl("https://evil.example/?x=1&y=2"));
    assert.equal(built.origin, "https://html.duckduckgo.com");
    assert.equal(built.pathname, "/html/");
    assert.equal(built.searchParams.get("q"), "https://evil.example/?x=1&y=2");
  });

  it("rejects cross-origin redirects and cancels their bodies", async () => {
    let cancelled = false;
    const result = await fetchReadablePage("test", 5, undefined, {
      wait: noWait,
      validatePublicUrl: allowPublic,
      fetch: async () =>
        responseFixture({
          status: 302,
          headers: { location: "https://evil.example/collect" },
          keepOpen: true,
          onCancel: () => {
            cancelled = true;
          },
        }),
    });

    if (result.ok) assert.fail("expected search failure");
    assert.match(result.error, /outside its fixed endpoint/);
    assert.equal(cancelled, true);
  });

  it("follows only same-origin endpoint redirects", async () => {
    const requested: string[] = [];
    const result = await fetchReadablePage("test", 1, undefined, {
      wait: noWait,
      validatePublicUrl: allowPublic,
      fetch: async (url) => {
        requested.push(url);
        if (requested.length === 1) {
          return responseFixture({
            status: 302,
            url,
            headers: { location: "/html/?q=test&ia=web" },
          });
        }
        return responseFixture({
          url,
          body:
            '<html><body><div class="result"><h2 class="result__title"><a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2F">Example result</a></h2><a class="result__snippet">Useful preview text.</a></div></body></html>',
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    });

    assert.equal(result.ok, true);
    assert.equal(requested.length, 2);
    assert.equal(new URL(requested[1]!).origin, "https://html.duckduckgo.com");
  });

  it("rejects an oversized declared body before reading it", async () => {
    let cancelled = false;
    const result = await fetchReadablePage("test", 5, undefined, {
      wait: noWait,
      validatePublicUrl: allowPublic,
      fetch: async () =>
        responseFixture({
          headers: { "content-length": String(MAX_SEARCH_BODY_BYTES + 1) },
          keepOpen: true,
          onCancel: () => {
            cancelled = true;
          },
        }),
    });

    if (result.ok) assert.fail("expected size failure");
    assert.match(result.error, /exceeds/);
    assert.equal(cancelled, true);
  });

  it("fails explicitly when expected result markup is absent", async () => {
    const result = await fetchReadablePage("test", 5, undefined, {
      wait: noWait,
      validatePublicUrl: allowPublic,
      fetch: async () =>
        responseFixture({
          body: "<html><body>challenge or markup drift</body></html>",
          headers: { "content-type": "text/html" },
        }),
    });

    if (result.ok) assert.fail("expected missing-markup failure");
    assert.match(result.error, /no recognizable result markup/i);
  });

  it("removes result nodes rejected by the public URL policy", async () => {
    const result = await fetchReadablePage("test", 5, undefined, {
      wait: noWait,
      validatePublicUrl: async (url) => {
        if (url.includes("127.0.0.1")) throw new Error("private address");
        return new URL(url).href;
      },
      fetch: async () =>
        responseFixture({
          body:
            '<html><body><div class="result"><h2><a class="result__a" href="/l/?uddg=http%3A%2F%2F127.0.0.1%2Fadmin">Internal</a></h2></div><div class="result"><h2><a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2F">Public</a></h2></div></body></html>',
          headers: { "content-type": "text/html" },
        }),
    });

    if (!result.ok) assert.fail(result.error);
    assert.equal(result.omittedUnsafeLinks, 1);
    assert.deepEqual(result.links.map((link) => link.url), ["https://example.com/"]);
  });

  it("never returns unvalidated duplicate or out-of-result anchors", async () => {
    const validated: string[] = [];
    const result = await fetchReadablePage("test", 5, undefined, {
      wait: noWait,
      validatePublicUrl: async (url) => {
        validated.push(url);
        return new URL(url).href;
      },
      fetch: async () =>
        responseFixture({
          body:
            '<html><body><div class="result"><a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2F">Public</a><a class="result__a" href="http://127.0.0.1/admin">Duplicate</a></div><a class="result__a" href="file:///etc/passwd" data-pi-safe-result-url="file:///etc/passwd">Outside</a></body></html>',
          headers: { "content-type": "text/html" },
        }),
    });

    if (!result.ok) assert.fail(result.error);
    assert.deepEqual(validated, ["https://example.com/"]);
    assert.deepEqual(result.links, [{ title: "Public", url: "https://example.com/" }]);
    assert.doesNotMatch(result.readableText, /127\.0\.0\.1|file:\/\/\//);
  });

  it("rejects an actual chunked body that crosses the byte ceiling", async () => {
    const result = await fetchReadablePage("test", 5, undefined, {
      wait: noWait,
      validatePublicUrl: allowPublic,
      fetch: async () =>
        responseFixture({
          body: "x".repeat(MAX_SEARCH_BODY_BYTES + 1),
          headers: { "content-type": "text/html" },
        }),
    });

    if (result.ok) assert.fail("expected a body-size failure");
    assert.match(result.error, /exceeds/);
  });

  it("does not return success when cancellation arrives during URL validation", async () => {
    const controller = new AbortController();
    await assert.rejects(
      fetchReadablePage("test", 5, controller.signal, {
        wait: noWait,
        validatePublicUrl: async (url) => {
          controller.abort(new DOMException("cancelled", "AbortError"));
          return new URL(url).href;
        },
        fetch: async () =>
          responseFixture({
            body:
              '<html><body><div class="result"><a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2F">Public</a></div></body></html>',
            headers: { "content-type": "text/html" },
          }),
      }),
      { name: "AbortError" },
    );
  });

  it("does not wait for an unresolved URL validator after Pi cancellation", async () => {
    const controller = new AbortController();
    let validationStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      validationStarted = resolve;
    });
    const pending = fetchReadablePage("test", 5, controller.signal, {
      wait: noWait,
      validatePublicUrl: async () => {
        validationStarted?.();
        return new Promise<string>(() => undefined);
      },
      fetch: async () =>
        responseFixture({
          body:
            '<html><body><div class="result"><a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2F">Public</a></div></body></html>',
          headers: { "content-type": "text/html" },
        }),
    });

    await started;
    controller.abort(new DOMException("cancelled", "AbortError"));
    await assert.rejects(pending, { name: "AbortError" });
  });

  it("propagates Pi cancellation instead of turning it into a search result", async () => {
    const controller = new AbortController();

    await assert.rejects(
      fetchReadablePage("test", 5, controller.signal, {
        wait: noWait,
        validatePublicUrl: allowPublic,
        fetch: async (_url, options) => {
          assert.equal(options.signal, controller.signal);
          controller.abort(new DOMException("cancelled", "AbortError"));
          controller.signal.throwIfAborted();
          return responseFixture();
        },
      }),
      { name: "AbortError" },
    );
  });
});
