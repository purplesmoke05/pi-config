/**
 * The only network transport used by smart-fetch.
 *
 * This deliberately uses Node's http/https clients instead of a browser or a
 * TLS impersonation library.  Hostname resolution is performed with
 * `dns.lookup(..., { all: true })`; every answer must be public before one is
 * selected and pinned through the request's lookup callback.  Redirects are
 * followed here (rather than by the client) so the same check is applied to
 * every hop.
 */

import * as dns from "node:dns";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import * as http from "node:http";
import * as https from "node:https";
import type {
  FetchResponseLike,
  ReadableBodyStream,
  BodyStreamReader,
} from "./types.ts";
import { MAX_TIMEOUT_MS } from "./constants.ts";

export const MAX_REDIRECTS = 5;
export const MAX_TEXT_BYTES = 5 * 1024 * 1024;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

class RequestTimeoutError extends Error {
  readonly code = "ETIMEDOUT";

  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms.`);
    this.name = "TimeoutError";
  }
}

export type AddressClassification =
  | "public"
  | "invalid"
  | "local"
  | "private"
  | "link-local"
  | "cgnat"
  | "reserved"
  | "multicast"
  | "ipv4-mapped";

export class PublicUrlError extends Error {
  readonly code = "public_url_required";

  constructor(message: string) {
    super(message);
    this.name = "PublicUrlError";
  }
}

export class ResponseBodyTooLargeError extends Error {
  readonly code = "response_too_large";
  readonly maxBytes: number;
  readonly downloadedBytes?: number;

  constructor(maxBytes: number, downloadedBytes?: number) {
    super(
      `Response body exceeds the ${maxBytes} byte limit${
        downloadedBytes === undefined ? "" : ` after ${downloadedBytes} bytes`
      }.`,
    );
    this.name = "ResponseBodyTooLargeError";
    this.maxBytes = maxBytes;
    this.downloadedBytes = downloadedBytes;
  }
}

export class TooManyRedirectsError extends Error {
  readonly code = "too_many_redirects";

  constructor(maxRedirects = MAX_REDIRECTS) {
    super(`Redirect limit (${maxRedirects}) exceeded.`);
    this.name = "TooManyRedirectsError";
  }
}

export class RedirectNotAllowedError extends Error {
  readonly code = "redirect_not_allowed";

  constructor(url: string) {
    super(`Redirect encountered while fetching ${url}.`);
    this.name = "RedirectNotAllowedError";
  }
}

export interface LookupAddress {
  address: string;
  family: 4 | 6;
}

export interface PublicUrlValidation {
  url: string;
  hostname: string;
  address: string;
  family: 4 | 6;
}

export type PublicUrlValidationCache = Map<string, PublicUrlValidation>;

function parseIPv4(value: string): [number, number, number, number] | null {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return null;
  }

  const octets = parts.map(Number) as [number, number, number, number];
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function classifyIPv4(value: string): AddressClassification {
  const octets = parseIPv4(value);
  if (!octets) return "invalid";

  const [a, b, c] = octets;
  if (a === 0 || a === 127) return "local";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
    return "private";
  }
  if (a === 100 && b >= 64 && b <= 127) return "cgnat";
  if (a === 169 && b === 254) return "link-local";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";

  // Special-use, documentation, benchmarking, and other non-global ranges.
  if (
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && b === 18) ||
    (a === 198 && b === 19) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    (a === 192 && b === 0 && (c === 9 || c === 10)) ||
    (a === 168 && b === 63 && c === 129 && octets[3] === 16)
  ) {
    return "reserved";
  }

  return "public";
}

function parseIPv6(value: string): number[] | null {
  let input = value.toLowerCase();
  if (input.includes("%")) return null;

  const embeddedIPv4 = input.match(/(?:^|:)(\d+(?:\.\d+){3})$/)?.[1];
  if (embeddedIPv4) {
    const octets = parseIPv4(embeddedIPv4);
    if (!octets) return null;
    const ipv4Hex = `${((octets[0] << 8) | octets[1]).toString(16)}:${((
      octets[2] << 8
    ) | octets[3]).toString(16)}`;
    input = input.replace(embeddedIPv4, ipv4Hex);
  }

  const halves = input.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) {
    return null;
  }

  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 && missing < 1) return null;
  return [
    ...left.map((part) => Number.parseInt(part, 16)),
    ...(halves.length === 2 ? Array.from({ length: missing }, () => 0) : []),
    ...right.map((part) => Number.parseInt(part, 16)),
  ];
}

function classifyIPv6(value: string): AddressClassification {
  const groups = parseIPv6(value);
  if (!groups) return "invalid";

  const isZero = groups.every((group) => group === 0);
  const isLoopback = groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
  if (isZero || isLoopback) return "local";

  // IPv4-mapped addresses must never be treated as a public IPv6 address.
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (mapped) return "ipv4-mapped";

  const first = groups[0];
  if ((first & 0xfe00) === 0xfc00) return "private"; // fc00::/7
  if ((first & 0xffc0) === 0xfe80) return "link-local"; // fe80::/10
  if ((first & 0xff00) === 0xff00) return "multicast"; // ff00::/8
  if ((first & 0xffc0) === 0xfec0) return "reserved"; // deprecated site-local

  // Documentation, benchmarking, protocol-assignment, and discard-only space.
  if (
    (first === 0x2001 && groups[1] <= 0x01ff) || // 2001::/23 special-use space
    (first === 0x2001 && groups[1] === 0x0db8) ||
    (first === 0x2001 && groups[1] === 0x0002) ||
    (first === 0x2001 && groups[1] === 0x0010) ||
    (first === 0x2001 && groups[1] === 0x0020) ||
    first === 0x2002 || // 6to4
    first === 0x3ffe || // 6bone
    (first === 0x3fff && groups[1] <= 0x0fff) || // 3fff::/20 documentation
    (first === 0x0100 && groups[1] === 0x0000)
  ) {
    return "reserved";
  }

  // Only globally assigned unicast space is allowed. This excludes future,
  // multicast-like, and otherwise special-use prefixes by default.
  if ((first & 0xe000) !== 0x2000) return "reserved";

  return "public";
}

/** Classify an IP literal. Hostnames are intentionally not accepted here. */
export function classifyAddress(address: string): AddressClassification {
  const family = isIP(address);
  if (family === 4) return classifyIPv4(address);
  if (family === 6) return classifyIPv6(address);
  return "invalid";
}

export function isPublicAddress(address: string): boolean {
  return classifyAddress(address) === "public";
}

// Common aliases make this small pure helper convenient to use from sibling
// extensions without making them depend on the transport implementation.
export const classifyIpAddress = classifyAddress;
export const isPublicIpAddress = isPublicAddress;

function canonicalizeUrl(input: string): URL {
  if (typeof input !== "string" || input.trim() === "") {
    throw new PublicUrlError("A non-empty URL is required.");
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new PublicUrlError(`Invalid URL: ${input}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new PublicUrlError(`Only http/https URLs are supported, got ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new PublicUrlError("URLs containing userinfo are not allowed.");
  }
  if (!parsed.hostname) {
    throw new PublicUrlError("URL hostname is required.");
  }

  // Fragments never reach an HTTP server. Removing them gives callers a stable
  // canonical URL and prevents a redirect cache from having two spellings.
  parsed.hash = "";
  return parsed;
}

function lookupAll(
  hostname: string,
  signal?: AbortSignal,
): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = () => {
      finish(() => reject(abortError(signal as AbortSignal)));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    dns.lookup(
      hostname,
      { all: true, verbatim: true },
      (error, addresses) => {
        finish(() => {
          if (error) {
            reject(error);
            return;
          }
          resolve(addresses as LookupAddress[]);
        });
      },
    );
  });
}

async function resolvePublicAddress(
  hostname: string,
  signal?: AbortSignal,
): Promise<LookupAddress> {
  signal?.throwIfAborted();
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    const family = literalFamily as 4 | 6;
    const classification = classifyAddress(hostname);
    if (classification !== "public") {
      throw new PublicUrlError(
        `Address ${hostname} is not public (${classification}).`,
      );
    }
    return selectPublicAddress(hostname, [{ address: hostname, family }]);
  }

  const addresses = await lookupAll(hostname, signal);
  return selectPublicAddress(hostname, addresses);
}

/** Pure DNS-answer policy used before a pinned request lookup callback. */
export function selectPublicAddress(
  hostname: string,
  addresses: ReadonlyArray<{ address: string; family: number }>,
): LookupAddress {
  if (addresses.length === 0) {
    throw new PublicUrlError(`Hostname ${hostname} did not resolve.`);
  }

  // Do not merely pick a public answer. A mixed DNS response is rejected so an
  // attacker cannot hide a private answer beside a public one.
  for (const answer of addresses) {
    const classification = classifyAddress(answer.address);
    if (classification !== "public") {
      throw new PublicUrlError(
        `Hostname ${hostname} resolved to a non-public address (${classification}).`,
      );
    }
  }

  const selected = addresses[0];
  if (!selected || (selected.family !== 4 && selected.family !== 6)) {
    throw new PublicUrlError(`Hostname ${hostname} returned an invalid address.`);
  }
  return { address: selected.address, family: selected.family as 4 | 6 };
}

export async function validatePublicHttpUrlDetailed(
  input: string,
  cache?: PublicUrlValidationCache,
  signal?: AbortSignal,
): Promise<PublicUrlValidation> {
  signal?.throwIfAborted();
  const parsed = canonicalizeUrl(input);
  const canonical = parsed.toString();
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const cacheKey = `${parsed.protocol}//${hostname}:${parsed.port || (parsed.protocol === "https:" ? "443" : "80")}`;
  const cached = cache?.get(cacheKey);
  if (cached) {
    return { ...cached, url: canonical };
  }

  const resolved = await resolvePublicAddress(hostname, signal);
  const validation = {
    url: canonical,
    hostname,
    address: resolved.address,
    family: resolved.family,
  } satisfies PublicUrlValidation;
  cache?.set(cacheKey, validation);
  return validation;
}

/** Return a canonical URL only after all DNS answers have passed public checks. */
export async function validatePublicHttpUrl(
  input: string,
  cache?: PublicUrlValidationCache,
): Promise<string> {
  return (await validatePublicHttpUrlDetailed(input, cache)).url;
}

export function createPublicUrlValidator(
  cache: PublicUrlValidationCache = new Map(),
): (input: string, signal?: AbortSignal) => Promise<string> {
  return (input, signal) =>
    validatePublicHttpUrlDetailed(input, cache, signal).then((result) => result.url);
}

export interface SafeRequestEvent {
  type?: "request_start" | "request_sent" | "response_headers" | "body_progress" | "body_complete" | "error";
  contentLength?: number;
  downloadedBytes?: number;
  status?: number;
  url?: string;
  message?: string;
}

export interface SafeFetchOptions {
  headers?: Record<string, string>;
  redirect?: string;
  timeout?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBytes?: number;
  onRequestEvent?: (event: SafeRequestEvent) => void;
  /** Internal lifecycle hook used to keep one operation deadline through body reads. */
  onBodyDone?(): void;
}

interface FetchOperation {
  signal: AbortSignal;
  deadlineAt?: number;
  markFinalResponse(): void;
  onBodyDone(): void;
  dispose(): void;
}

function createFetchOperation(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): FetchOperation {
  if (signal?.aborted) {
    throw abortError(signal);
  }

  const controller = new AbortController();
  const deadlineAt =
    timeoutMs !== undefined && timeoutMs > 0 ? Date.now() + timeoutMs : undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let finalResponse = false;
  let disposed = false;
  let externalAbortHandler: (() => void) | undefined;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (externalAbortHandler) {
      signal?.removeEventListener("abort", externalAbortHandler);
    }
  };
  const markFinalResponse = () => {
    finalResponse = true;
    // An abort can race the response callback before safeFetch gets a chance
    // to mark this response as final. Dispose here as well so that such a
    // response cannot retain the operation's timer or external listener.
    if (controller.signal.aborted) dispose();
  };
  const onBodyDone = () => {
    if (finalResponse) dispose();
  };

  externalAbortHandler = () => {
    controller.abort(abortError(signal as AbortSignal));
  };
  signal?.addEventListener("abort", externalAbortHandler, { once: true });
  if (deadlineAt !== undefined) {
    timeoutHandle = setTimeout(() => {
      controller.abort(new RequestTimeoutError(timeoutMs as number));
    }, Math.max(0, deadlineAt - Date.now()));
  }

  return {
    signal: controller.signal,
    deadlineAt,
    markFinalResponse,
    onBodyDone,
    dispose,
  };
}

function remainingTimeout(deadlineAt: number | undefined): number | undefined {
  if (deadlineAt === undefined) return undefined;
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    throw new RequestTimeoutError(MAX_TIMEOUT_MS);
  }
  return remaining;
}

function normalizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  const forbidden = new Set([
    "host",
    "connection",
    "content-length",
    "transfer-encoding",
    "upgrade",
    "te",
    "trailer",
    "proxy-connection",
    "keep-alive",
    "expect",
    "proxy-authorization",
  ]);
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value !== "string") continue;
    if (forbidden.has(name.toLowerCase())) {
      throw new PublicUrlError(`Request header ${name} is not allowed.`);
    }
    normalized[name] = value;
  }
  if (!Object.keys(normalized).some((name) => name.toLowerCase() === "accept-encoding")) {
    normalized["Accept-Encoding"] = "identity";
  }
  return normalized;
}

function headerValue(headers: http.IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function parseContentLength(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function isTextualContentType(value: string): boolean {
  const contentType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    contentType.startsWith("text/") ||
    contentType === "application/json" ||
    contentType === "text/json" ||
    contentType.endsWith("+json") ||
    contentType === "application/xml" ||
    contentType === "text/xml" ||
    contentType.endsWith("+xml") ||
    contentType === "application/javascript" ||
    contentType === "application/x-javascript" ||
    contentType === "application/ecmascript" ||
    contentType === "image/svg+xml"
  );
}

export function contentLimit(contentType: string, requested: unknown): number {
  const policyLimit = isTextualContentType(contentType)
    ? MAX_TEXT_BYTES
    : MAX_FILE_BYTES;
  if (typeof requested === "number" && Number.isFinite(requested) && requested >= 0) {
    return Math.min(Math.floor(requested), policyLimit);
  }
  return policyLimit;
}

function bodyStream(
  response: http.IncomingMessage,
  maxBytes: number,
  emit: (event: SafeRequestEvent) => void,
  signal?: AbortSignal,
): ReadableBodyStream<Uint8Array> {
  const source = Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>;
  const sourceReader = source.getReader();
  let downloadedBytes = 0;
  let completed = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;

  const detachAbort = () => {
    signal?.removeEventListener("abort", onAbort);
  };
  const failForAbort = () => {
    if (completed) return;
    completed = true;
    const error = abortError(signal as AbortSignal);
    detachAbort();
    emit({ type: "error", downloadedBytes, message: error.message });
    void sourceReader.cancel(error).catch(() => undefined);
    controllerRef?.error(error);
  };
  const onAbort = () => {
    failForAbort();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      if (signal?.aborted) onAbort();
    },
    async pull(controller) {
      try {
        const next = await sourceReader.read();
        if (next.done) {
          if (!completed) {
            completed = true;
            detachAbort();
            emit({ type: "body_complete", downloadedBytes });
          }
          controller.close();
          return;
        }

        const value = next.value ?? new Uint8Array();
        if (downloadedBytes + value.byteLength > maxBytes) {
          completed = true;
          detachAbort();
          downloadedBytes += value.byteLength;
          await sourceReader.cancel("response body too large").catch(() => undefined);
          const error = new ResponseBodyTooLargeError(maxBytes, downloadedBytes);
          emit({ type: "error", downloadedBytes, message: error.message });
          controller.error(error);
          return;
        }

        downloadedBytes += value.byteLength;
        emit({ type: "body_progress", downloadedBytes });
        controller.enqueue(value);
      } catch (error) {
        if (completed) return;
        completed = true;
        detachAbort();
        emit({
          type: "error",
          downloadedBytes,
          message: error instanceof Error ? error.message : String(error),
        });
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (!completed) {
        completed = true;
        detachAbort();
        emit({
          type: "error",
          downloadedBytes,
          message: reason === undefined ? "response body canceled" : String(reason),
        });
      }
      await sourceReader.cancel(reason).catch(() => undefined);
    },
  });

  if (signal?.aborted) {
    // The stream's start hook may have observed an already-aborted signal;
    // avoid adding a listener after the abort event has already fired.
    onAbort();
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
  }

  return stream as unknown as ReadableBodyStream<Uint8Array>;
}

async function cancelResponseBody(response: FetchResponseLike, reason: string): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader() as BodyStreamReader<Uint8Array>;
  try {
    await reader.cancel(reason);
  } catch {
    // Redirect response is discarded; its cancellation error must not mask the
    // policy decision for the next hop.
  } finally {
    reader.releaseLock();
  }
}

export function stripCredentialHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) =>
        !["authorization", "cookie", "proxy-authorization"].includes(
          name.toLowerCase(),
        ),
    ),
  );
}

function sameOrigin(left: URL, right: URL): boolean {
  return left.origin === right.origin;
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(reason === undefined ? "The operation was aborted." : String(reason));
  error.name = "AbortError";
  return error;
}

async function requestOne(
  validation: PublicUrlValidation,
  options: SafeFetchOptions,
  headers: Record<string, string>,
): Promise<FetchResponseLike> {
  const parsed = new URL(validation.url);
  const requestModule = parsed.protocol === "https:" ? https : http;
  const timeoutMs =
    typeof options.timeoutMs === "number" ? options.timeoutMs : options.timeout;
  const emit = options.onRequestEvent ?? (() => undefined);
  const requestHeaders = { ...headers };
  emit({ type: "request_start", url: validation.url });

  if (options.signal?.aborted) throw abortError(options.signal);

  return new Promise<FetchResponseLike>((resolve, reject) => {
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;

    const cleanup = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (abortHandler) options.signal?.removeEventListener("abort", abortHandler);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      emit({
        type: "error",
        url: validation.url,
        message: error instanceof Error ? error.message : String(error),
      });
      reject(error);
    };

    const requestOptions = {
      protocol: parsed.protocol,
      hostname: validation.hostname,
      port: parsed.port || undefined,
      method: "GET",
      // Never reuse a socket from a global agent. Reusing a pooled socket can
      // bypass the per-hop pinned lookup callback after a DNS change.
      agent: false,
      path: `${parsed.pathname || "/"}${parsed.search}`,
      headers: requestHeaders,
      family: validation.family,
      autoSelectFamily: false,
      // The callback ignores the hostname supplied by Node and pins the
      // address selected by the all-answer public DNS check above.
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions && "all" in lookupOptions && lookupOptions.all) {
          callback(null, [{ address: validation.address, family: validation.family }]);
          return;
        }
        callback(null, validation.address, validation.family);
      },
      ...(parsed.protocol === "https:" && !isIP(validation.hostname)
        ? { servername: validation.hostname }
        : {}),
    } as http.RequestOptions & { autoSelectFamily?: boolean };

    const request = requestModule.request(requestOptions, (response) => {
      if (settled) {
        response.resume();
        return;
      }

      const contentType = headerValue(response.headers, "content-type") ?? "";
      const maxBytes = contentLimit(contentType, options.maxBytes);
      const contentLength = parseContentLength(
        headerValue(response.headers, "content-length"),
      );
      if (contentLength !== undefined && contentLength > maxBytes) {
        const error = new ResponseBodyTooLargeError(maxBytes, contentLength);
        response.once("error", () => undefined);
        response.destroy(error);
        fail(error);
        return;
      }

      emit({
        type: "response_headers",
        status: response.statusCode,
        contentLength,
        url: validation.url,
      });

      const body = bodyStream(response, maxBytes, (event) => {
        emit(event);
        if (event.type === "body_complete" || event.type === "error") {
          cleanup();
          options.onBodyDone?.();
        }
      }, options.signal);
      let consumed = false;
      const readAll = async (): Promise<Uint8Array> => {
        if (consumed) throw new Error("Response body has already been consumed.");
        consumed = true;
        const reader = body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            if (next.value) {
              chunks.push(next.value);
              total += next.value.byteLength;
            }
          }
        } finally {
          reader.releaseLock();
        }
        const result = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return result;
      };

      const result: FetchResponseLike = {
        ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
        status: response.statusCode ?? 0,
        statusText: response.statusMessage ?? "",
        url: validation.url,
        headers: {
          get(name: string) {
            return headerValue(response.headers, name) ?? null;
          },
        },
        body,
        async text() {
          return Buffer.from(await readAll()).toString("utf8");
        },
        async arrayBuffer() {
          const bytes = await readAll();
          return bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer;
        },
        readable() {
          return Readable.fromWeb(
            body as unknown as import("node:stream/web").ReadableStream<any>,
          );
        },
      };
      if (options.signal?.aborted) {
        fail(abortError(options.signal));
        return;
      }
      settled = true;
      resolve(result);
    });

    request.once("finish", () => emit({ type: "request_sent", url: validation.url }));
    request.once("error", (error) => {
      if (settled) cleanup();
      fail(error);
    });
    if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        request.destroy(new RequestTimeoutError(timeoutMs));
      }, timeoutMs);
      request.setTimeout(timeoutMs, () => {
        request.destroy(new RequestTimeoutError(timeoutMs));
      });
    }
    if (options.signal) {
      abortHandler = () => request.destroy(abortError(options.signal as AbortSignal));
      options.signal.addEventListener("abort", abortHandler, { once: true });
      if (options.signal.aborted) abortHandler();
    }
    request.end();
  });
}

function asSafeFetchOptions(options: Record<string, unknown>): SafeFetchOptions {
  const requestedTimeout =
    typeof options.timeoutMs === "number"
      ? options.timeoutMs
      : typeof options.timeout === "number"
        ? options.timeout
        : undefined;
  const timeout =
    requestedTimeout !== undefined &&
    Number.isFinite(requestedTimeout) &&
    requestedTimeout > 0
      ? Math.min(MAX_TIMEOUT_MS, requestedTimeout)
      : undefined;
  return {
    headers: options.headers as Record<string, string> | undefined,
    redirect: typeof options.redirect === "string" ? options.redirect : undefined,
    timeout,
    timeoutMs: timeout,
    signal: options.signal as AbortSignal | undefined,
    maxBytes: typeof options.maxBytes === "number" ? options.maxBytes : undefined,
    onRequestEvent:
      typeof options.onRequestEvent === "function"
        ? (options.onRequestEvent as SafeFetchOptions["onRequestEvent"])
        : undefined,
  };
}

/** Fetch one URL through pinned Node http/https, following at most five hops. */
export async function safeFetch(
  input: string,
  rawOptions: Record<string, unknown> = {},
): Promise<FetchResponseLike> {
  const options = asSafeFetchOptions(rawOptions);
  const requestedTimeout = options.timeoutMs ?? options.timeout;
  const operation = createFetchOperation(options.signal, requestedTimeout);
  let current = input;
  let redirects = 0;
  let credentialsStripped = false;

  try {
    let headers = normalizeHeaders(options.headers);
    while (true) {
      operation.signal.throwIfAborted();
      const validation = await validatePublicHttpUrlDetailed(
        current,
        undefined,
        operation.signal,
      );
      const response = await requestOne(
        validation,
        {
          ...options,
          signal: operation.signal,
          timeoutMs: remainingTimeout(operation.deadlineAt),
          onBodyDone: operation.onBodyDone,
        },
        headers,
      );
      const location = response.headers.get("location");
      const statusRedirect = [301, 302, 303, 307, 308].includes(response.status);
      if (!statusRedirect || !location) {
        response.credentialsStripped = credentialsStripped;
        operation.markFinalResponse();
        return response;
      }

      // Expose one validated hop to callers that need to apply an endpoint-
      // specific redirect policy (the search extension does this).  The core
      // fetch path requests `follow`, which still performs the same validation
      // and credential stripping below, without delegating redirects to Node.
      if (options.redirect === "manual") {
        response.credentialsStripped = credentialsStripped;
        operation.markFinalResponse();
        return response;
      }

      if (options.redirect === "error") {
        await cancelResponseBody(response, "redirect disabled");
        throw new RedirectNotAllowedError(validation.url);
      }

      if (redirects >= MAX_REDIRECTS) {
        await cancelResponseBody(response, "redirect limit exceeded");
        throw new TooManyRedirectsError(MAX_REDIRECTS);
      }

      let next: URL;
      try {
        next = new URL(location, validation.url);
      } catch {
        await cancelResponseBody(response, "invalid redirect URL");
        throw new PublicUrlError(`Invalid redirect URL: ${location}`);
      }
      await cancelResponseBody(response, "following validated redirect");
      const previous = new URL(validation.url);
      if (!sameOrigin(previous, next)) {
        headers = stripCredentialHeaders(headers);
        credentialsStripped = true;
      }
      current = next.toString();
      redirects += 1;
    }
  } catch (error) {
    operation.dispose();
    throw error;
  }
}

export default safeFetch;
