/**
 * Persistent cache for Ollama Cloud model discovery.
 *
 * Stores raw /api/show responses at ~/.pi/agent/cache/ollama-cloud/models.json
 * with a configurable TTL.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// --- Types ---

export type ModelSource = "ollama" | "modelsdev" | "inference";

export interface OllamaShowResponse {
  details: {
    family: string;
    parameter_size: string;
  };
  model_info: Record<string, unknown>;
  capabilities: string[];
}

export interface CacheEntry {
  id: string;
  show: OllamaShowResponse | null;
  source: ModelSource;
  /** Provider-specific reasoning effort values from models.dev, persisted so offline/discovery can build thinkingLevelMap without re-fetching. */
  effortValues?: string[];
}

export interface CacheData {
  timestamp: number;
  models: CacheEntry[];
}

// --- Paths ---

function getCacheDir(): string {
  return join(getAgentDir(), "cache", "ollama-cloud");
}

function getCacheFile(): string {
  return join(getCacheDir(), "models.json");
}

// --- I/O ---

export function readCache(options?: { ignoreTTL?: boolean }): CacheData | null {
  try {
    const file = getCacheFile();
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, "utf-8");
    const data = JSON.parse(raw) as CacheData;
    if (!options?.ignoreTTL && Date.now() - data.timestamp > CACHE_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

export function writeCache(data: CacheData): void {
  try {
    const dir = getCacheDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(getCacheFile(), JSON.stringify(data, null, 2));
  } catch {
    // Ignore cache write errors
  }
}

export function getCacheInfo(): {
  exists: boolean;
  age: string | null;
  size: string | null;
  modelCount: number;
  sources: Record<ModelSource, number>;
} {
  const file = getCacheFile();
  if (!existsSync(file)) {
    return { exists: false, age: null, size: null, modelCount: 0, sources: { ollama: 0, modelsdev: 0, inference: 0 } };
  }
  try {
    const raw = readFileSync(file, "utf-8");
    const data = JSON.parse(raw) as CacheData;
    const ageMs = Date.now() - data.timestamp;
    const minutes = Math.floor(ageMs / 60000);
    const hours = Math.floor(minutes / 60);
    const age = hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
    const sizeBytes = Buffer.byteLength(raw);
    const size = sizeBytes > 1024 ? `${(sizeBytes / 1024).toFixed(1)} KB` : `${sizeBytes} B`;

    const sources: Record<ModelSource, number> = { ollama: 0, modelsdev: 0, inference: 0 };
    for (const entry of data.models) {
      sources[entry.source]++;
    }

    return {
      exists: true,
      age,
      size,
      modelCount: data.models.length,
      sources,
    };
  } catch {
    return { exists: false, age: null, size: null, modelCount: 0, sources: { ollama: 0, modelsdev: 0, inference: 0 } };
  }
}
