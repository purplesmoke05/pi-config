/**
 * Model discovery from the Ollama Cloud API.
 *
 * Priority chain (per model):
 *   1. POST /api/show          — capabilities, context length (primary)
 *   2. https://models.dev/api.json — fallback if /api/show fails
 *   3. Name-based inference    — last resort
 *
 * Discovery modes:
 *   "ollama"    — try /api/show first, fallback to models.dev (default)
 *   "modelsdev" — bypass /api/show, use models.dev data directly
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OllamaShowResponse, CacheEntry, CacheData, ModelSource } from "./cache.js";
import { readCache, writeCache } from "./cache.js";
import {
  getModelsDevData,
  resolveFromModelsDev,
  inferFromName,
  type ModelsDevModelData,
  type ResolvedModelData,
} from "./fallback.js";

// --- Offline check ---

function isOffline(): boolean {
  return process.env.PI_OFFLINE === "1" || process.env.PI_OFFLINE === "true";
}

export const OLLAMA_BASE = "https://ollama.com";
const FETCH_TIMEOUT_MS = 10_000;

// --- API helpers ---

function extractContextLength(modelInfo: Record<string, unknown>): number {
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith(".context_length") && typeof value === "number") {
      return value;
    }
  }
  return 128_000;
}

async function fetchModelIds(): Promise<string[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_BASE}/v1/models`, {
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = (await res.json()) as { data: Array<{ id: string }> };
    return data.data.map((m) => m.id);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchModelShow(modelId: string): Promise<OllamaShowResponse | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as OllamaShowResponse;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// --- Fallback resolution ---

function resolveFallback(
  id: string,
  modelsDevData: Map<string, ModelsDevModelData> | null,
): { data: ResolvedModelData; source: Exclude<ModelSource, "ollama"> } {
  // Priority 1: models.dev exact match
  if (modelsDevData) {
    const fromModelsDev = resolveFromModelsDev(id, modelsDevData);
    if (fromModelsDev) return { data: fromModelsDev, source: "modelsdev" };
  }

  // Priority 2: name-based inference
  return { data: inferFromName(id), source: "inference" };
}

/**
 * Offline fallback resolution — uses only name-based inference (no network).
 * Uses the cached source if the entry already has one, but still resolves
 * the actual model config data via inferFromName for entries with show:null.
 */
function resolveFallbackOffline(
  entry: CacheEntry,
): { data: ResolvedModelData; source: Exclude<ModelSource, "ollama"> } {
  return { data: inferFromName(entry.id), source: entry.source === "ollama" ? "inference" : entry.source };
}

// --- Model assembly ---

/** pi thinking levels plus the synthetic "off" level. */
type ModelThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * Maps models.dev reasoning effort value names to pi thinking levels.
 * Provider-specific aliases collapse onto pi's 6-level scale. Unmatched
 * values are ignored (their level stays hidden), so only values models.dev
 * explicitly declares as supported are exposed to the user.
 */
const EFFORT_NAME_TO_LEVEL: Record<string, ModelThinkingLevel> = {
  off: "off",
  none: "off",
  disabled: "off",
  disable: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  max: "xhigh",
  maximum: "xhigh",
  ultra: "xhigh",
  xhigh: "xhigh",
};

type ThinkingLevelMap = NonNullable<ProviderModelConfig["thinkingLevelMap"]>;

/**
 * Build a thinkingLevelMap by name-matching provider effort values to pi
 * levels. Levels absent from the model's effort values stay `null` (hidden
 * and skipped/clamped by pi). For glm-5.2's `["high", "max"]` this yields
 * `{ off:null, minimal:null, low:null, medium:null, high:"high", xhigh:"max" }`.
 */
function buildThinkingLevelMap(values: string[]): ThinkingLevelMap {
  const map: ThinkingLevelMap = {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: null,
    xhigh: null,
  };
  for (const v of values) {
    const level = EFFORT_NAME_TO_LEVEL[v.toLowerCase()];
    if (level && map[level] === null) map[level] = v;
  }
  return map;
}

/** Emergency kill switch: skip sending reasoning_effort entirely (legacy behavior). */
function isEffortControlDisabled(): boolean {
  const v = process.env.PI_OLLAMA_CLOUD_NO_EFFORT;
  return v === "1" || v === "true" || v === "yes";
}

function buildModelConfig(
  id: string,
  show: OllamaShowResponse | null,
  fallback: ResolvedModelData,
  source: ModelSource,
  effortValues?: string[],
): ProviderModelConfig {
  let contextWindow: number;
  let reasoning: boolean;
  let input: ("text" | "image")[];

  if (show) {
    // Primary: real /api/show data
    contextWindow = extractContextLength(show.model_info ?? {});
    reasoning = show.capabilities?.includes("thinking") ?? false;
    input = show.capabilities?.includes("vision")
      ? ["text", "image"]
      : ["text"];
  } else {
    // Fallback data
    contextWindow = fallback.contextWindow;
    reasoning = fallback.reasoning;
    input = fallback.input;
  }

  // Only effort-type models (discrete effort values from models.dev) get a
  // thinkingLevelMap + supportsReasoningEffort. Toggle-only reasoning models
  // keep legacy behavior (no reasoning_effort sent); pi still shows off..high
  // but the provider runs at its own default intensity.
  const effectiveEffort =
    !isEffortControlDisabled() && reasoning && effortValues && effortValues.length > 0
      ? effortValues
      : undefined;
  const thinkingLevelMap = effectiveEffort
    ? buildThinkingLevelMap(effectiveEffort)
    : undefined;

  return {
    id,
    name: id,
    reasoning,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: fallback.maxTokens,
    compat: thinkingLevelMap
      ? { supportsDeveloperRole: false, supportsReasoningEffort: true }
      : { supportsDeveloperRole: false, supportsReasoningEffort: false },
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
  };
}

export function registerProvider(pi: ExtensionAPI, models: ProviderModelConfig[]) {
  pi.registerProvider("ollama-cloud", {
    baseUrl: `${OLLAMA_BASE}/v1`,
    apiKey: "$OLLAMA_CLOUD_API_KEY",
    api: "openai-completions",
    models,
  });
}

// --- Discovery (shared by startup and refresh) ---

export type DiscoveryMode = "ollama" | "modelsdev";

export interface DiscoverResult {
  count: number;
  sources: Record<ModelSource, number>;
  error?: string;
}

export async function discoverModels(
  pi: ExtensionAPI,
  options: { force?: boolean; mode?: DiscoveryMode } = {},
): Promise<DiscoverResult> {
  const { force = false, mode = "ollama" } = options;

  // OFFLINE MODE: use only cached data, no network calls
  if (isOffline()) {
    const cached = readCache({ ignoreTTL: true });
    if (cached) {
      const models: ProviderModelConfig[] = [];
      const sources: Record<ModelSource, number> = { ollama: 0, modelsdev: 0, inference: 0 };
      for (const entry of cached.models) {
        const { data: fallback, source } = resolveFallbackOffline(entry);
        const actualSource = entry.show ? "ollama" : (entry.source !== "ollama" ? entry.source : source);
        models.push(buildModelConfig(entry.id, entry.show, fallback, actualSource, entry.effortValues));
        sources[actualSource]++;
      }
      registerProvider(pi, models);
      return { count: models.length, sources };
    }
    return {
      count: 0,
      sources: { ollama: 0, modelsdev: 0, inference: 0 },
      error: "Offline mode: no cached models available",
    };
  }

  // MODE: models.dev only — bypass /api/show entirely
  if (mode === "modelsdev") {
    const modelsDevData = await getModelsDevData();
    if (modelsDevData.size === 0) {
      return {
        count: 0,
        sources: { ollama: 0, modelsdev: 0, inference: 0 },
        error: "models.dev data unavailable",
      };
    }

    const entries: CacheEntry[] = [];
    const models: ProviderModelConfig[] = [];
    const sources: Record<ModelSource, number> = { ollama: 0, modelsdev: 0, inference: 0 };

    for (const [id, data] of modelsDevData) {
      const resolved = resolveFromModelsDev(id, modelsDevData)!;
      const config = buildModelConfig(id, null, resolved, "modelsdev", resolved.effortValues);
      entries.push({ id, show: null, source: "modelsdev", effortValues: resolved.effortValues });
      models.push(config);
      sources.modelsdev++;
    }

    writeCache({ timestamp: Date.now(), models: entries });
    registerProvider(pi, models);
    return { count: models.length, sources };
  }

  // MODE: ollama (default) — try /api/show first

  // Try cache first (unless forced)
  const cached = !force ? readCache() : null;
  if (cached) {
    // Need models.dev when any entry lacks /api/show data OR effort values
    // (effort values come from models.dev, not /api/show).
    const needsFallback = cached.models.some((entry) => !entry.show || !entry.effortValues);
    let modelsDevData: Map<string, ModelsDevModelData> | null = null;
    if (needsFallback) {
      modelsDevData = await getModelsDevData();
    }

    const models: ProviderModelConfig[] = [];
    const sources: Record<ModelSource, number> = { ollama: 0, modelsdev: 0, inference: 0 };
    for (const entry of cached.models) {
      const { data: fallback, source } = await resolveFallback(entry.id, modelsDevData);
      const actualSource = entry.show ? "ollama" : source;
      const effortValues = entry.effortValues ?? fallback.effortValues;
      models.push(buildModelConfig(entry.id, entry.show, fallback, actualSource, effortValues));
      sources[actualSource]++;
    }
    registerProvider(pi, models);
    return { count: models.length, sources };
  }

  // Fetch fresh
  let modelIds: string[];
  try {
    modelIds = await fetchModelIds();
  } catch (err) {
    return {
      count: 0,
      sources: { ollama: 0, modelsdev: 0, inference: 0 },
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }

  // Step 1: Try /api/show for ALL models
  const results = await Promise.allSettled(
    modelIds.map(async (id) => {
      const show = await fetchModelShow(id);
      return { id, show };
    }),
  );

  // Step 2: Separate successes from failures
  const successes: Array<{ id: string; show: OllamaShowResponse }> = [];
  const failedIds: string[] = [];

  for (const result of results) {
    if (result.status === "fulfilled" && result.value.show) {
      successes.push({ id: result.value.id, show: result.value.show });
    } else if (result.status === "fulfilled") {
      failedIds.push(result.value.id);
    } else {
      failedIds.push("unknown");
    }
  }

  // Step 3: Always load models.dev — it's the source of reasoning effort
  // values even for models whose /api/show succeeded. Disk-cached (24h) +
  // in-memory, so this is a cheap read after the first run.
  const modelsDevData = await getModelsDevData();

  // Step 4: Build configs with source tracking
  const entries: CacheEntry[] = [];
  const models: ProviderModelConfig[] = [];
  const sources: Record<ModelSource, number> = { ollama: 0, modelsdev: 0, inference: 0 };

  for (const { id, show } of successes) {
    const { data: fallback } = await resolveFallback(id, modelsDevData);
    entries.push({ id, show, source: "ollama", effortValues: fallback.effortValues });
    models.push(buildModelConfig(id, show, fallback, "ollama", fallback.effortValues));
    sources.ollama++;
  }

  for (const id of failedIds) {
    const { data: fallback, source } = await resolveFallback(id, modelsDevData);
    entries.push({ id, show: null, source, effortValues: fallback.effortValues });
    models.push(buildModelConfig(id, null, fallback, source, fallback.effortValues));
    sources[source]++;
  }

  writeCache({ timestamp: Date.now(), models: entries });
  registerProvider(pi, models);

  return { count: models.length, sources };
}
