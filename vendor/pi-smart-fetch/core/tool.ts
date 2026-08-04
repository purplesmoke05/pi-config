import { type TSchema, Type } from "typebox";
import {
  DEFAULT_BATCH_CONCURRENCY,
  DEFAULT_INCLUDE_REPLIES,
  DEFAULT_MAX_CHARS,
  DEFAULT_TIMEOUT_MS,
  MAX_RETURN_CHARS,
  MAX_TIMEOUT_MS,
} from "./constants.ts";
import { defuddleFetch, isError } from "./extract.ts";
import {
  buildFetchErrorResponseText,
  buildUserFacingFetchErrorSummary,
  sanitizeSingleLineText,
} from "./format.ts";
import type {
  BatchFetchItemProgress,
  BatchFetchItemResult,
  BatchFetchItemStatus,
  BatchFetchProgressSnapshot,
  BatchFetchResult,
  FetchError,
  FetchExecutionHooks,
  FetchOptions,
  FetchResult,
  FetchToolConfig,
  FetchToolDefaults,
  OutputFormat,
} from "./types.ts";

function resolveBatchConcurrency(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) {
    return DEFAULT_BATCH_CONCURRENCY;
  }

  return Math.min(4, Math.max(1, Math.floor(value)));
}

function clampPositive(
  value: unknown,
  fallback: number,
  maximum: number,
  integer = false,
): number {
  const fallbackValue =
    typeof fallback === "number" && Number.isFinite(fallback) && fallback > 0
      ? Math.min(maximum, integer ? Math.floor(fallback) : fallback)
      : Math.min(maximum, integer ? Math.floor(maximum) : maximum);
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallbackValue;
  }
  const normalized = integer ? Math.floor(value) : value;
  return Math.min(maximum, normalized);
}

export function resolveFetchToolDefaults(
  config: FetchToolConfig = {},
): FetchToolDefaults {
  return {
    maxChars: clampPositive(
      config.maxChars,
      DEFAULT_MAX_CHARS,
      MAX_RETURN_CHARS,
      true,
    ),
    timeoutMs: clampPositive(
      config.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    ),
    browser: "node",
    os: process.platform,
    removeImages: config.removeImages ?? false,
    includeReplies: config.includeReplies ?? DEFAULT_INCLUDE_REPLIES,
    batchConcurrency: resolveBatchConcurrency(config.batchConcurrency),
    // Download paths are fixed by the core; caller/project settings cannot
    // redirect fetched files.
    tempDir: undefined,
  };
}

export function createBaseFetchToolParameterProperties(
  defaults: FetchToolDefaults,
): Record<string, TSchema> {
  return {
    url: Type.String({ description: "URL to fetch (http/https only)" }),
    headers: Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description:
          "Custom HTTP headers to send. By default, Accept and Accept-Language are set automatically.",
      }),
    ),
    maxChars: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: MAX_RETURN_CHARS,
        description: `Maximum characters to return. Default: ${defaults.maxChars}; maximum: ${MAX_RETURN_CHARS}`,
      }),
    ),
    timeoutMs: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: MAX_TIMEOUT_MS,
        description: `Request timeout in milliseconds. Default: ${defaults.timeoutMs}; maximum: ${MAX_TIMEOUT_MS}`,
      }),
    ),
    format: Type.Optional(
      Type.Union(
        [
          Type.Literal("markdown"),
          Type.Literal("html"),
          Type.Literal("text"),
          Type.Literal("json"),
          Type.Literal("raw"),
        ],
        {
          description:
            'Output format. "markdown" (default), "html" (cleaned HTML), "text" (plain text, no formatting), "json" (pretty-printed JSON), or "raw" (full raw server response without extraction or truncation, for further parsing)',
        },
      ),
    ),
    removeImages: Type.Optional(
      Type.Boolean({
        description: "Strip image references from output. Default: false",
      }),
    ),
    includeReplies: Type.Optional(
      Type.Union([Type.Boolean(), Type.Literal("extractors")], {
        description:
          "Include replies/comments: 'extractors' for site-specific only (default), true for all, false for none",
      }),
    ),
  };
}

export function createBatchFetchToolParameterProperties(
  defaults: FetchToolDefaults,
): Record<string, TSchema> {
  return {
    requests: Type.Array(
      Type.Object(createBaseFetchToolParameterProperties(defaults), {
        additionalProperties: false,
      }),
      {
        minItems: 1,
        maxItems: 10,
        description:
          "Array of up to 10 fetch requests. Each item accepts the same parameters as the single-item fetch tool.",
      },
    ),
  };
}

function buildFetchOptionsFromParams(
  params: Record<string, unknown>,
  defaults: FetchToolDefaults,
  signal?: AbortSignal,
): FetchOptions {
  return {
    url: params.url as string,
    headers: params.headers as Record<string, string> | undefined,
    maxChars: clampPositive(
      params.maxChars,
      defaults.maxChars,
      MAX_RETURN_CHARS,
      true,
    ),
    format: (params.format as OutputFormat | undefined) ?? "markdown",
    removeImages: (params.removeImages as boolean) ?? defaults.removeImages,
    includeReplies:
      (params.includeReplies as boolean | "extractors") ??
      defaults.includeReplies,
    timeoutMs: clampPositive(
      params.timeoutMs,
      defaults.timeoutMs,
      MAX_TIMEOUT_MS,
    ),
    signal,
    tempDir: defaults.tempDir,
  };
}

export async function executeFetchToolCall(
  params: Record<string, unknown>,
  defaults: FetchToolDefaults,
  hooks: FetchExecutionHooks = {},
): Promise<FetchResult | FetchError> {
  return defuddleFetch(
    buildFetchOptionsFromParams(params, defaults, hooks.signal),
    hooks,
  );
}

const PROGRESS_BY_STATUS: Record<BatchFetchItemStatus, number> = {
  queued: 0,
  connecting: 0,
  waiting: 0.11,
  loading: 0.51,
  processing: 0.96,
  done: 1,
  error: 1,
};

function createInitialProgressItems(
  requests: Record<string, unknown>[],
): BatchFetchItemProgress[] {
  return requests.map((request, index) => ({
    index,
    url:
      typeof request.url === "string" ? request.url : String(request.url ?? ""),
    status: "queued",
    progress: PROGRESS_BY_STATUS.queued,
    statusStartedAt: Date.now(),
  }));
}

function buildProgressSnapshot(
  items: BatchFetchItemProgress[],
  batchConcurrency: number,
): BatchFetchProgressSnapshot {
  let completed = 0;
  let succeeded = 0;
  let failed = 0;

  for (const item of items) {
    if (item.status === "done" || item.status === "error") {
      completed += 1;
    }
    if (item.status === "done") {
      succeeded += 1;
    }
    if (item.status === "error") {
      failed += 1;
    }
  }

  return {
    items: items.map((item) => ({ ...item })),
    total: items.length,
    completed,
    succeeded,
    failed,
    batchConcurrency,
  };
}

export async function executeBatchFetchToolCall(
  params: Record<string, unknown>,
  defaults: FetchToolDefaults,
  options: {
    batchConcurrency?: number;
    signal?: AbortSignal;
    onProgress?(snapshot: BatchFetchProgressSnapshot): void;
    executeItem?(
      params: Record<string, unknown>,
      defaults: FetchToolDefaults,
      hooks?: FetchExecutionHooks,
    ): Promise<FetchResult | FetchError>;
  } = {},
): Promise<BatchFetchResult> {
  const requests = (
    (params.requests as Record<string, unknown>[] | undefined) ?? []
  ).map((request) => request ?? {});
  if (requests.length === 0) {
    throw new RangeError("batch_web_fetch requires at least one request.");
  }
  if (requests.length > 10) {
    throw new RangeError("batch_web_fetch accepts at most 10 requests.");
  }
  if (options.signal?.aborted) {
    throw options.signal.reason instanceof Error
      ? options.signal.reason
      : new Error("The operation was aborted.");
  }
  const batchConcurrency = resolveBatchConcurrency(
    options.batchConcurrency ?? defaults.batchConcurrency,
  );
  const progressItems = createInitialProgressItems(requests);
  const results = new Array<BatchFetchItemResult>(requests.length);

  const emitProgress = () => {
    options.onProgress?.(
      buildProgressSnapshot(progressItems, batchConcurrency),
    );
  };

  const updateProgress = (
    index: number,
    status: BatchFetchItemStatus,
    error?: string,
    progress?: number,
  ) => {
    const previous = progressItems[index];
    progressItems[index] = {
      ...previous,
      status,
      progress:
        progress === undefined
          ? PROGRESS_BY_STATUS[status]
          : Math.max(0, Math.min(1, progress)),
      statusStartedAt:
        previous?.status === status ? previous.statusStartedAt : Date.now(),
      ...(error ? { error } : {}),
    };
    emitProgress();
  };

  emitProgress();

  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= requests.length) {
        return;
      }

      const request = requests[index] ?? {};
      const normalizedRequest = buildFetchOptionsFromParams(request, defaults);

      try {
        const executeItem = options.executeItem ?? executeFetchToolCall;
        if (options.signal?.aborted) {
          throw options.signal.reason instanceof Error
            ? options.signal.reason
            : new Error("The operation was aborted.");
        }
        const result = await executeItem(request, defaults, {
          signal: options.signal,
          onStatusChange(status) {
            if (status === "done") return;
            updateProgress(index, status);
          },
          onProgressChange(update) {
            if (update.status === "done") return;
            updateProgress(index, update.status, undefined, update.progress);
          },
        });

        if (options.signal?.aborted) {
          throw options.signal.reason instanceof Error
            ? options.signal.reason
            : new Error("The operation was aborted.");
        }

        if (isError(result)) {
          const errorText = buildFetchErrorResponseText(result);
          results[index] = {
            index,
            request: normalizedRequest,
            status: "error",
            progress: PROGRESS_BY_STATUS.error,
            error: errorText,
          };
          updateProgress(
            index,
            "error",
            buildUserFacingFetchErrorSummary(result),
          );
          continue;
        }

        results[index] = {
          index,
          request: normalizedRequest,
          status: "done",
          progress: PROGRESS_BY_STATUS.done,
          result,
        };
        updateProgress(index, "done");
      } catch (error) {
        if (options.signal?.aborted) {
          throw options.signal.reason instanceof Error
            ? options.signal.reason
            : new Error("The operation was aborted.");
        }
        const message = sanitizeSingleLineText(
          error instanceof Error ? error.message : String(error),
        );
        results[index] = {
          index,
          request: normalizedRequest,
          status: "error",
          progress: PROGRESS_BY_STATUS.error,
          error: message,
        };
        updateProgress(index, "error", message);
      }
    }
  };

  const workerCount =
    requests.length === 0 ? 0 : Math.min(batchConcurrency, requests.length);
  await Promise.all(Array.from({ length: workerCount }, async () => worker()));

  const finalSnapshot = buildProgressSnapshot(progressItems, batchConcurrency);

  return {
    items: results,
    total: finalSnapshot.total,
    succeeded: finalSnapshot.succeeded,
    failed: finalSnapshot.failed,
    batchConcurrency,
  };
}
