import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  createDefuddleFetch,
  isError,
  streamResponseToFile,
} from "./extract.ts";
import {
  buildFetchErrorResponseText,
  buildFetchResponseText,
  buildUserFacingFetchErrorSummary,
} from "./format.ts";
import {
  MAX_FILE_BYTES,
  MAX_TEXT_BYTES,
  stripCredentialHeaders,
} from "./safe-http.ts";
import type {
  FetchDependencies,
  FetchError,
  FetchResponseLike,
  FetchResult,
} from "./types.ts";

function response(
  body: string | Uint8Array,
  options: {
    url?: string;
    contentType?: string;
    disposition?: string;
    contentLength?: number;
    status?: number;
    headers?: Record<string, string>;
    credentialsStripped?: boolean;
  } = {},
): FetchResponseLike {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  const headers = new Map<string, string>([
    ["content-type", options.contentType ?? "text/html"],
    ["content-length", String(options.contentLength ?? bytes.byteLength)],
    ...(options.disposition
      ? [["content-disposition", options.disposition] as const]
      : []),
    ...Object.entries(options.headers ?? {}).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ] as const),
  ]);

  return {
    ok: (options.status ?? 200) >= 200 && (options.status ?? 200) < 300,
    status: options.status ?? 200,
    statusText: options.status === 404 ? "Not Found" : "OK",
    url: options.url ?? "https://example.com/",
    credentialsStripped: options.credentialsStripped,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    async text() {
      return text;
    },
    async arrayBuffer() {
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
    },
    readable() {
      throw new Error("readable() is not used by this test response");
    },
  };
}

function harness(
  fetchImpl: FetchDependencies["fetch"],
  defuddleImpl: FetchDependencies["defuddle"] = async () => ({
    content: "Extracted content",
    wordCount: 2,
  }),
) {
  return createDefuddleFetch({
    fetch: fetchImpl,
    defuddle: defuddleImpl,
    getProfiles: () => [],
  });
}

test("cross-origin hops strip all credential headers", () => {
  const stripped = stripCredentialHeaders({
    Authorization: "Bearer secret",
    Cookie: "session=secret",
    "Proxy-Authorization": "Basic secret",
    Accept: "text/plain",
  });
  assert.deepEqual(stripped, { Accept: "text/plain" });
});

test("meta redirects strip credentials before the next fetch", async () => {
  const calls: Array<{ url: string; options: Record<string, unknown> }> = [];
  const fetcher = harness(async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) {
      return response(
        '<meta http-equiv="refresh" content="0;url=https://example.org/next">',
        { url },
      );
    }
    return response("plain result", { url, contentType: "text/plain" });
  });

  const result = await fetcher({
    url: "https://example.com/start",
    headers: {
      Authorization: "Bearer secret",
      Cookie: "session=secret",
      "Proxy-Authorization": "Basic secret",
    },
  });
  assert.equal(isError(result), false);
  const headers = calls[1]?.options.headers as Record<string, string>;
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers.Cookie, undefined);
  assert.equal(headers["Proxy-Authorization"], undefined);
});

test("credentials stay stripped after an HTTP cross-origin hop returns to the original origin", async () => {
  const calls: Array<{ url: string; options: Record<string, unknown> }> = [];
  const fetcher = harness(async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) {
      return response(
        '<meta http-equiv="refresh" content="0;url=https://example.com/return">',
        { url: "https://example.org/landing" },
      );
    }
    return response("plain result", { url, contentType: "text/plain" });
  });

  const result = await fetcher({
    url: "https://example.com/start",
    headers: {
      Authorization: "Bearer secret",
      Cookie: "session=secret",
      "Proxy-Authorization": "Basic secret",
    },
  });

  assert.equal(isError(result), false);
  const headers = calls[1]?.options.headers as Record<string, string>;
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers.Cookie, undefined);
  assert.equal(headers["Proxy-Authorization"], undefined);
});

test("credentials stay stripped when an HTTP chain returned before a meta hop", async () => {
  const calls: Array<{ url: string; options: Record<string, unknown> }> = [];
  const fetcher = harness(async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) {
      return response(
        '<meta http-equiv="refresh" content="0;url=https://example.com/final">',
        {
          url: "https://example.com/http-return",
          credentialsStripped: true,
        },
      );
    }
    return response("plain result", { url, contentType: "text/plain" });
  });

  const result = await fetcher({
    url: "https://example.com/start",
    headers: {
      Authorization: "Bearer secret",
      Cookie: "session=secret",
      "Proxy-Authorization": "Basic secret",
    },
  });

  assert.equal(isError(result), false);
  const headers = calls[1]?.options.headers as Record<string, string>;
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers.Cookie, undefined);
  assert.equal(headers["Proxy-Authorization"], undefined);
});

test("alternate links strip credentials and Defuddle never enables async extractors", async () => {
  const calls: Array<{ url: string; options: Record<string, unknown> }> = [];
  const defuddleOptions: Record<string, unknown>[] = [];
  const fetcher = harness(
    async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) {
        return response(
          '<html><head><link rel="alternate" type="text/markdown" href="https://example.org/article.md"></head><body>thin</body></html>',
          { url },
        );
      }
      return response("# alternate content", {
        url,
        contentType: "text/markdown",
      });
    },
    async (_document, _url, options) => {
      defuddleOptions.push(options);
      return { content: undefined, wordCount: 0 };
    },
  );

  const result = await fetcher({
    url: "https://example.com/article",
    headers: {
      Authorization: "Bearer secret",
      Cookie: "session=secret",
      "Proxy-Authorization": "Basic secret",
    },
  });
  assert.equal(isError(result), false);
  const headers = calls[1]?.options.headers as Record<string, string>;
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers.Cookie, undefined);
  assert.equal(headers["Proxy-Authorization"], undefined);
  assert.equal(defuddleOptions[0]?.useAsync, false);
});

test("text hard cap is enforced before extraction", async () => {
  const oversized = new Uint8Array(MAX_TEXT_BYTES + 1);
  const fetcher = harness(async (url) =>
    response(oversized, {
      url,
      contentType: "text/plain",
      contentLength: oversized.byteLength,
    }),
  );
  const result = await fetcher({ url: "https://example.com/large.txt" });
  assert.equal(isError(result), true);
  if (isError(result)) {
    assert.match(result.error, /limit|exceeds/i);
  }
});

test("file downloads use the fixed private cache and 0600 mode", async () => {
  const name = `pi-smart-fetch-test-${randomUUID()}.bin`;
  const fetcher = harness(async (url) =>
    response(new Uint8Array([1, 2, 3]), {
      url,
      contentType: "application/octet-stream",
      disposition: `attachment; filename="${name}"`,
    }),
  );
  const result = await fetcher({
    url: "https://example.com/download",
    tempDir: "/tmp/should-be-ignored",
  });
  assert.equal(isError(result), false);
  if (!isError(result)) {
    assert.equal(result.kind, "file");
    const file = result as Extract<FetchResult, { kind: "file" }>;
    const expectedDir = join(getAgentDir(), "cache", "pi-smart-fetch", "downloads");
    assert.equal(file.filePath, join(expectedDir, name));
    const info = await stat(file.filePath);
    assert.equal(info.mode & 0o777, 0o600);
    const dirInfo = await stat(expectedDir);
    assert.equal(dirInfo.mode & 0o777, 0o700);
    await unlink(file.filePath);
    await chmod(expectedDir, 0o700);
  }
});

test("a colliding download name retries without consuming the response body", async () => {
  const name = `pi-smart-fetch-collision-${randomUUID()}.bin`;
  const expectedDir = join(getAgentDir(), "cache", "pi-smart-fetch", "downloads");
  const occupiedPath = join(expectedDir, name);
  const alternatePath = join(expectedDir, name.replace(/\.bin$/, "-1.bin"));
  await mkdir(expectedDir, { recursive: true });
  await writeFile(occupiedPath, new Uint8Array([9]), { flag: "wx", mode: 0o600 });

  try {
    const fetcher = harness(async (url) =>
      response(new Uint8Array([1, 2, 3]), {
        url,
        contentType: "application/octet-stream",
        disposition: `attachment; filename="${name}"`,
      }),
    );
    const result = await fetcher({ url: "https://example.com/download" });

    assert.equal(isError(result), false);
    if (!isError(result)) {
      assert.equal(result.kind, "file");
      const file = result as Extract<FetchResult, { kind: "file" }>;
      assert.equal(file.filePath, alternatePath);
      assert.equal(file.fileSize, 3);
      assert.deepEqual(await readFile(file.filePath), Buffer.from([1, 2, 3]));
    }
  } finally {
    await unlink(occupiedPath).catch(() => undefined);
    await unlink(alternatePath).catch(() => undefined);
  }
});

test("one timeout covers client-side redirects and extraction", async () => {
  let calls = 0;
  const fetcher = harness(async (url, options) => {
    calls += 1;
    if (calls === 1) {
      return response(
        '<meta http-equiv="refresh" content="0;url=https://example.com/next">',
        { url },
      );
    }

    const signal = options.signal as AbortSignal;
    return await new Promise<FetchResponseLike>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });

  const startedAt = Date.now();
  const result = await fetcher({
    url: "https://example.com/start",
    timeoutMs: 30,
  });

  assert.equal(isError(result), true);
  if (isError(result)) assert.match(result.error, /timed out|deadline|timeout/i);
  assert.equal(calls, 2);
  assert.ok(Date.now() - startedAt < 500);
});

test("an unresolved injected Defuddle operation observes the deadline", async () => {
  const fetcher = harness(
    async (url) =>
      response("<html><body><main>content</main></body></html>", {
        url,
        contentType: "text/html",
      }),
    async () => new Promise(() => undefined),
  );

  const startedAt = Date.now();
  const result = await fetcher({
    url: "https://example.com/article",
    timeoutMs: 30,
  });

  assert.equal(isError(result), true);
  if (isError(result)) assert.match(result.error, /timed out|deadline|timeout/i);
  assert.ok(Date.now() - startedAt < 500);
});

test("fetched text strips terminal control characters", async () => {
  const fetcher = harness(async (url) =>
    response("safe\u001b]52;c;payload\u0007text\u009b31m", {
      url,
      contentType: "text/plain",
    }),
  );

  const result = await fetcher({ url: "https://example.com/control.txt" });
  assert.equal(isError(result), false);
  if (!isError(result) && result.kind === "content") {
    assert.doesNotMatch(result.content, /[\u001b\u0007\u009b]/);
    assert.match(result.content, /safe�]52;c;payload�text�31m/);
  }
});

test("external fetch metadata and errors cannot inject terminal controls or lines", async () => {
  const fetcher = harness(
    async (url) =>
      response("<html><body><main>article body</main></body></html>", {
        url,
        contentType: "text/html",
      }),
    async () => ({
      content: "article body",
      wordCount: 2,
      title: "safe\u001b]52;c;payload\u0007title\u009b31m",
      author: "author\n> forged: yes",
      published: "today\rrewritten",
      site: "site\tshifted",
      language: "en\u2028> forged-language: yes",
    }),
  );

  const result = await fetcher({ url: "https://example.com/article" });
  assert.equal(isError(result), false);
  if (!isError(result)) {
    const rendered = buildFetchResponseText(result, { verbose: true });
    assert.doesNotMatch(rendered, /[\u001b\u0007\u009b]/);
    assert.doesNotMatch(rendered, /\n> forged:/);
    assert.doesNotMatch(rendered, /\n> forged-language:/);
  }

  const externalError: FetchError = {
    error: "failed\u001b]52;c;x\u0007\n> forged-error: yes",
    code: "http_error",
    phase: "loading",
    retryable: false,
    url: "https://example.com/",
    statusCode: 502,
    statusText: "Bad\u009b31m\n> forged-status: yes",
  };
  const errorText = buildFetchErrorResponseText(externalError);
  const summary = buildUserFacingFetchErrorSummary(externalError);
  assert.doesNotMatch(`${errorText}${summary}`, /[\u001b\u0007\u009b]/);
  assert.doesNotMatch(errorText, /\n> forged-error:/);
  assert.doesNotMatch(summary, /\n> forged-status:/);
});

test("file Content-Length overflow fails before creating a partial file", async () => {
  const name = `pi-smart-fetch-overflow-${randomUUID()}.bin`;
  const fetcher = harness(async (url) =>
    response(new Uint8Array([1]), {
      url,
      contentType: "application/octet-stream",
      contentLength: MAX_FILE_BYTES + 1,
      disposition: `attachment; filename="${name}"`,
    }),
  );
  const result = await fetcher({ url: "https://example.com/overflow" });
  assert.equal(isError(result), true);
  const expectedPath = join(
    getAgentDir(),
    "cache",
    "pi-smart-fetch",
    "downloads",
    name,
  );
  await assert.rejects(stat(expectedPath), { code: "ENOENT" });
});

test("stream file overflow unlinks a partial output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-smart-fetch-test-"));
  const filePath = join(directory, "partial.bin");
  try {
    await assert.rejects(
      streamResponseToFile(
        response(new Uint8Array([1, 2, 3]), {
          contentType: "application/octet-stream",
        }),
        filePath,
        2,
      ),
      /limit|exceeds/i,
    );
    await assert.rejects(stat(filePath), { code: "ENOENT" });
  } finally {
    await rmdir(directory);
  }
});

test("batch runtime caps requests and concurrency", async () => {
  const { executeBatchFetchToolCall, resolveFetchToolDefaults } = await import("./tool.ts");
  const defaults = resolveFetchToolDefaults({ batchConcurrency: 99 });
  let active = 0;
  let maximum = 0;
  const item = async (params: Record<string, unknown>) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return {
      kind: "content",
      url: String(params.url),
      finalUrl: String(params.url),
      title: "",
      author: "",
      published: "",
      site: "",
      language: "",
      wordCount: 0,
      browser: "node",
      os: process.platform,
      content: "ok",
    } satisfies FetchResult;
  };
  const result = await executeBatchFetchToolCall(
    { requests: Array.from({ length: 10 }, (_, index) => ({ url: `https://example.com/${index}` })) },
    defaults,
    { batchConcurrency: 99, executeItem: item },
  );
  assert.equal(result.total, 10);
  assert.equal(result.batchConcurrency, 4);
  assert.ok(maximum <= 4);
  await assert.rejects(
    executeBatchFetchToolCall(
      { requests: Array.from({ length: 11 }, () => ({ url: "https://example.com" })) },
      defaults,
      { executeItem: item },
    ),
    /at most 10/i,
  );
});

test("runtime maxChars and timeoutMs clamps cannot be raised by config", async () => {
  const { resolveFetchToolDefaults } = await import("./tool.ts");
  const defaults = resolveFetchToolDefaults({
    maxChars: Number.MAX_SAFE_INTEGER,
    timeoutMs: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(defaults.maxChars, 200_000);
  assert.equal(defaults.timeoutMs, 60_000);
});

test("batch abort stops queued work", async () => {
  const { executeBatchFetchToolCall, resolveFetchToolDefaults } = await import("./tool.ts");
  const controller = new AbortController();
  const defaults = resolveFetchToolDefaults();
  const item = async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return {
      kind: "content",
      url: "https://example.com",
      finalUrl: "https://example.com",
      title: "",
      author: "",
      published: "",
      site: "",
      language: "",
      wordCount: 0,
      browser: "node",
      os: process.platform,
      content: "ok",
    } satisfies FetchResult;
  };
  const pending = executeBatchFetchToolCall(
    { requests: Array.from({ length: 10 }, () => ({ url: "https://example.com" })) },
    defaults,
    { signal: controller.signal, executeItem: item },
  );
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, /abort/i);
});
