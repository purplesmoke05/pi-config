/**
 * Real web tools for research workflows. These execute in the extension host
 * process (which has network access), not in a subagent sandbox. Network access
 * is supplied by the host through a mandatory bounded public-text boundary;
 * this module has no ambient/global fetch fallback.
 *
 * - web_search: best-effort Bing HTML scrape -> result {url, title}
 * - web_fetch:  fetch a URL and return readable text (HTML stripped, truncated)
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

export const WEB_REQUEST_TIMEOUT_MS = 15_000;
export const WEB_RESPONSE_MAX_BYTES = 1024 * 1024;

export interface WebTextResponse {
  status: number;
  url: string;
  body: string;
}

export interface WebToolsRuntime {
  fetchText(
    url: string,
    options: {
      timeoutMs: number;
      maxBytes: number;
      redirect: "follow" | "error";
      contentTypes: "textual" | readonly string[];
      headers: Record<string, string>;
      signal?: AbortSignal;
    },
  ): Promise<WebTextResponse>;
  validatePublicUrl(url: string, signal?: AbortSignal): Promise<string>;
}

function assertRuntime(runtime: WebToolsRuntime): void {
  if (!runtime || typeof runtime.fetchText !== "function" || typeof runtime.validatePublicUrl !== "function") {
    throw new Error("Web tools require an audited public-text fetch runtime.");
  }
}

async function fetchText(
  runtime: WebToolsRuntime,
  url: string,
  options: {
    redirect: "follow" | "error";
    contentTypes: "textual" | readonly string[];
    signal?: AbortSignal;
  },
): Promise<WebTextResponse> {
  return runtime.fetchText(url, {
    timeoutMs: WEB_REQUEST_TIMEOUT_MS,
    maxBytes: WEB_RESPONSE_MAX_BYTES,
    redirect: options.redirect,
    contentTypes: options.contentTypes,
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9" },
    signal: options.signal,
  });
}

function rethrowAbort(signal: AbortSignal | undefined, error: unknown): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : error;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n +/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseBingResults(html: string, limit: number): Array<{ url: string; title: string }> {
  const out: Array<{ url: string; title: string }> = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<h2[^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const url = m[1];
    if (/\.bing\.com|go\.microsoft\.com/.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: m[2].replace(/<[^>]+>/g, "").trim() });
    if (out.length >= limit) break;
  }
  return out;
}

/** A tool that searches the web (best-effort) and returns result URLs + titles. */
export function createWebSearchTool(runtime: WebToolsRuntime): ToolDefinition {
  assertRuntime(runtime);
  return defineTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web and return a list of result URLs and titles. Use before web_fetch to find sources.",
    promptSnippet: "Search the web for sources",
    parameters: Type.Object({
      query: Type.String({ description: "The search query." }),
      count: Type.Optional(Type.Number({ description: "Max results (default 6)." })),
    }),
    async execute(_id, params: { query: string; count?: number }, signal) {
      const limit = Math.min(Math.max(params.count ?? 6, 1), 10);
      try {
        const { status, body } = await fetchText(
          runtime,
          `https://www.bing.com/search?q=${encodeURIComponent(params.query)}`,
          {
            redirect: "error",
            contentTypes: ["text/html", "application/xhtml+xml"],
            signal,
          },
        );
        const candidates = parseBingResults(body, limit);
        const results = (
          await Promise.all(
            candidates.map(async (result) => {
              try {
                return {
                  ...result,
                  url: await runtime.validatePublicUrl(result.url, signal),
                };
              } catch (error) {
                rethrowAbort(signal, error);
                return null;
              }
            }),
          )
        ).filter((result): result is { url: string; title: string } => result !== null);
        const text = results.length
          ? results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n")
          : `No results parsed (HTTP ${status}). Try a different query or fetch a known URL directly.`;
        return { content: [{ type: "text", text }], details: { results } };
      } catch (error) {
        rethrowAbort(signal, error);
        return {
          content: [{ type: "text", text: `web_search failed: ${error instanceof Error ? error.message : error}` }],
          details: { results: [] as Array<{ url: string; title: string }> },
        };
      }
    },
  }) as unknown as ToolDefinition;
}

/** A tool that fetches a URL and returns readable text. */
export function createWebFetchTool(runtime: WebToolsRuntime, maxChars = 6000): ToolDefinition {
  assertRuntime(runtime);
  return defineTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a URL and return its readable text content (HTML stripped, truncated).",
    promptSnippet: "Fetch a URL's text",
    parameters: Type.Object({
      url: Type.String({ description: "The absolute URL to fetch." }),
    }),
    async execute(_id, params: { url: string }, signal) {
      try {
        const { status, body, url } = await fetchText(runtime, params.url, {
          redirect: "follow",
          contentTypes: "textual",
          signal,
        });
        const text = htmlToText(body).slice(0, maxChars);
        return {
          content: [{ type: "text", text: `HTTP ${status} ${url}\n\n${text}` }],
          details: { status, url },
        };
      } catch (error) {
        rethrowAbort(signal, error);
        return {
          content: [
            {
              type: "text",
              text: `web_fetch failed for ${params.url}: ${error instanceof Error ? error.message : error}`,
            },
          ],
          details: { status: 0, url: params.url },
        };
      }
    },
  }) as unknown as ToolDefinition;
}

/** Both web tools, for injecting into a research workflow's agents. */
export function createWebTools(runtime: WebToolsRuntime): ToolDefinition[] {
  assertRuntime(runtime);
  return [createWebSearchTool(runtime), createWebFetchTool(runtime)];
}
