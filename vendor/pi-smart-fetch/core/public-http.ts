/**
 * Narrow public-network text boundary for sibling vendored extensions.
 *
 * Callers must supply finite operation and body limits. The underlying
 * transport validates every DNS answer, pins the selected public address,
 * and re-applies that policy to every redirect hop.
 */

import { MAX_TIMEOUT_MS } from "./constants.ts";
import {
  isTextualContentType,
  MAX_TEXT_BYTES,
  safeFetch,
} from "./safe-http.ts";
import type { FetchResponseLike } from "./types.ts";

export interface PublicTextRequestOptions {
  timeoutMs: number;
  maxBytes: number;
  redirect: "follow" | "error";
  contentTypes: "textual" | readonly string[];
  headers?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

export interface PublicTextResponse {
  status: number;
  statusText: string;
  url: string;
  contentType: string;
  body: string;
}

export type PublicFetch = (
  url: string,
  options: Record<string, unknown>,
) => Promise<FetchResponseLike>;

export class NonTextResponseError extends Error {
  readonly code = "non_text_response";

  constructor(contentType: string) {
    super(
      contentType
        ? `Expected a textual response, received ${contentType}.`
        : "Expected a textual response with a Content-Type header.",
    );
    this.name = "NonTextResponseError";
  }
}

function positiveFiniteInteger(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive finite number.`);
  }
  return Math.floor(value);
}

function boundedPositiveInteger(
  value: number,
  label: string,
  maximum: number,
): number {
  const normalized = positiveFiniteInteger(value, label);
  if (normalized > maximum) {
    throw new RangeError(`${label} must not exceed ${maximum}.`);
  }
  return normalized;
}

function normalizeContentType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function contentTypeAllowed(
  contentType: string,
  allowed: PublicTextRequestOptions["contentTypes"],
): boolean {
  if (!contentType) return false;
  if (allowed === "textual") return isTextualContentType(contentType);
  const normalized = normalizeContentType(contentType);
  return allowed.some((candidate) => normalizeContentType(candidate) === normalized);
}

async function cancelBody(response: FetchResponseLike, reason: string): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  try {
    try {
      await reader.cancel(reason);
    } catch {
      // The response is rejected regardless; cancellation cleanup must not
      // replace the MIME policy error returned to the caller.
    }
  } finally {
    reader.releaseLock();
  }
}

/** Fetch bounded text through the audited public-only HTTP transport. */
export async function safeFetchText(
  url: string,
  options: PublicTextRequestOptions,
  fetchImpl: PublicFetch = safeFetch,
): Promise<PublicTextResponse> {
  const timeoutMs = boundedPositiveInteger(options.timeoutMs, "timeoutMs", MAX_TIMEOUT_MS);
  const maxBytes = boundedPositiveInteger(options.maxBytes, "maxBytes", MAX_TEXT_BYTES);
  const response = await fetchImpl(url, {
    headers: options.headers ? { ...options.headers } : undefined,
    redirect: options.redirect,
    timeoutMs,
    maxBytes,
    signal: options.signal,
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentTypeAllowed(contentType, options.contentTypes)) {
    await cancelBody(response, "non-text response rejected");
    throw new NonTextResponseError(contentType);
  }

  return {
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    contentType,
    body: await response.text(),
  };
}
