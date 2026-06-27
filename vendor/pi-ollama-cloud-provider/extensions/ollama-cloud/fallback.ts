/**
 * Fallback metadata from https://models.dev/api.json
 *
 * Fetches the ollama-cloud section on-demand when /api/show fails.
 * Cached locally with 24h TTL.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const MODELS_DEV_URL = "https://models.dev/api.json";
const MODELS_DEV_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 15_000;

// --- Types ---

export interface ModelsDevReasoningOption {
  /** "effort" = discrete effort levels; "toggle" = on/off only. */
  type: string;
  /** Present only for `type: "effort"`; provider-specific effort value strings. */
  values?: string[];
}

export interface ModelsDevModelData {
  name: string;
  reasoning: boolean;
  reasoning_options?: ModelsDevReasoningOption[];
  limit?: {
    context?: number;
    output?: number;
  };
  modalities?: {
    input?: string[];
    output?: string[];
  };
  cost?: unknown;
}

export interface ResolvedModelData {
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ("text" | "image")[];
  /** Provider-specific reasoning effort values (e.g. ["high", "max"]) for `type: "effort"` models. Undefined for toggle-only or non-reasoning models. */
  effortValues?: string[];
}

// --- Cache ---

function getModelsDevCacheFile(): string {
  const dir = join(getAgentDir(), "cache", "ollama-cloud");
  mkdirSync(dir, { recursive: true });
  return join(dir, "models-dev.json");
}

function readModelsDevCache(options?: { ignoreTTL?: boolean }): Map<string, ModelsDevModelData> | null {
  try {
    const file = getModelsDevCacheFile();
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, "utf-8");
    const data = JSON.parse(raw) as { timestamp: number; models: Record<string, ModelsDevModelData> };
    if (!options?.ignoreTTL && Date.now() - data.timestamp > MODELS_DEV_TTL_MS) return null;
    return new Map(Object.entries(data.models));
  } catch {
    return null;
  }
}

function writeModelsDevCache(models: Record<string, ModelsDevModelData>): void {
  try {
    const dir = join(getAgentDir(), "cache", "ollama-cloud");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      getModelsDevCacheFile(),
      JSON.stringify({ timestamp: Date.now(), models }, null, 2),
    );
  } catch {
    // Ignore
  }
}

// --- Lazy fetch (only called when /api/show fails) ---

let modelsDevCache: Map<string, ModelsDevModelData> | null | "loading" | "failed" = null;

function isOffline(): boolean {
  return process.env.PI_OFFLINE === "1" || process.env.PI_OFFLINE === "true";
}

export async function getModelsDevData(): Promise<Map<string, ModelsDevModelData>> {
  // OFFLINE MODE: use disk cache (even if expired), never fetch
  if (isOffline()) {
    const diskOffline = readModelsDevCache({ ignoreTTL: true });
    return diskOffline ?? new Map();
  }

  if (modelsDevCache && modelsDevCache !== "loading" && modelsDevCache !== "failed") {
    return modelsDevCache;
  }
  if (modelsDevCache === "loading") {
    // Wait for in-flight request
    while (modelsDevCache === "loading") {
      await new Promise((r) => setTimeout(r, 50));
    }
    return modelsDevCache === "failed" ? new Map() : modelsDevCache!;
  }

  // Try disk cache
  const disk = readModelsDevCache();
  if (disk) {
    modelsDevCache = disk;
    return disk;
  }

  // Fetch from API
  modelsDevCache = "loading";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(MODELS_DEV_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = (await res.json()) as Record<string, unknown>;
    const ollamaCloud = data["ollama-cloud"] as { models?: Record<string, ModelsDevModelData> };
    const models = ollamaCloud?.models ?? {};
    writeModelsDevCache(models);
    modelsDevCache = new Map(Object.entries(models));
    return modelsDevCache;
  } catch {
    modelsDevCache = "failed";
    return new Map();
  } finally {
    clearTimeout(timeout);
  }
}

// --- Name-based inference (last resort) ---

const NAME_RULES: Array<{ pattern: string; contextWindow: number; maxTokens: number; reasoning: boolean }> = [
  { pattern: "deepseek-v4", contextWindow: 1_000_000, maxTokens: 65_536, reasoning: true },
  { pattern: "deepseek", contextWindow: 262_144, maxTokens: 65_536, reasoning: true },
  { pattern: "kimi", contextWindow: 262_144, maxTokens: 262_144, reasoning: true },
  { pattern: "glm-5", contextWindow: 200_000, maxTokens: 131_072, reasoning: true },
  { pattern: "glm", contextWindow: 200_000, maxTokens: 65_536, reasoning: true },
  { pattern: "qwen3.5", contextWindow: 262_144, maxTokens: 65_536, reasoning: true },
  { pattern: "qwen3", contextWindow: 262_144, maxTokens: 65_536, reasoning: true },
  { pattern: "qwen", contextWindow: 128_000, maxTokens: 32_768, reasoning: false },
  { pattern: "gpt-oss", contextWindow: 131_072, maxTokens: 16_384, reasoning: true },
  { pattern: "minimax", contextWindow: 204_800, maxTokens: 131_072, reasoning: true },
  { pattern: "gemma4", contextWindow: 262_144, maxTokens: 65_536, reasoning: true },
  { pattern: "gemma3", contextWindow: 131_072, maxTokens: 8_192, reasoning: false },
  { pattern: "gemma", contextWindow: 32_768, maxTokens: 8_192, reasoning: false },
  { pattern: "mistral-large", contextWindow: 262_144, maxTokens: 262_144, reasoning: false },
  { pattern: "devstral", contextWindow: 256_000, maxTokens: 256_000, reasoning: false },
  { pattern: "ministral", contextWindow: 128_000, maxTokens: 128_000, reasoning: false },
  { pattern: "mistral", contextWindow: 32_768, maxTokens: 32_768, reasoning: false },
  { pattern: "nemotron", contextWindow: 131_072, maxTokens: 16_384, reasoning: false },
  { pattern: "cogito", contextWindow: 262_144, maxTokens: 131_072, reasoning: true },
  { pattern: "gemini", contextWindow: 1_048_000, maxTokens: 65_536, reasoning: true },
];

export function inferFromName(modelId: string): ResolvedModelData {
  const lower = modelId.toLowerCase();
  for (const rule of NAME_RULES) {
    if (lower.includes(rule.pattern)) {
      return { contextWindow: rule.contextWindow, maxTokens: rule.maxTokens, reasoning: rule.reasoning, input: ["text"] };
    }
  }
  return { contextWindow: 128_000, maxTokens: 32_768, reasoning: false, input: ["text"] };
}

// --- Resolve from models.dev (only called when /api/show failed) ---

export function resolveFromModelsDev(
  id: string,
  data: Map<string, ModelsDevModelData>,
): ResolvedModelData | null {
  const entry = data.get(id);
  if (!entry) return null;

  const input: ("text" | "image")[] = entry.modalities?.input?.includes("image")
    ? ["text", "image"]
    : ["text"];

  const effortOption = entry.reasoning_options?.find(
    (o) => o.type === "effort" && Array.isArray(o.values) && o.values.length > 0,
  );

  return {
    contextWindow: entry.limit?.context ?? 128_000,
    maxTokens: entry.limit?.output ?? 32_768,
    reasoning: entry.reasoning ?? false,
    input,
    effortValues: effortOption?.values,
  };
}
