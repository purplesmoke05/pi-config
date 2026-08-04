import { parseHTML } from "linkedom";

export const MAX_HTML_ELEMENTS = 50_000;
export const MAX_HTML_NESTING_DEPTH = 256;

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const RAW_TEXT_ELEMENTS = new Set(["script", "style"]);

function isTagNameCharacter(character: string | undefined): boolean {
  return character !== undefined && /[a-z0-9:-]/i.test(character);
}

function findTagEnd(html: string, start: number): number {
  let quote: "\"" | "'" | undefined;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") return index;
  }
  return -1;
}

/** Reject pathological DOM shapes before linkedom or Defuddle sees attacker-controlled HTML. */
export function assertHtmlWithinComplexityLimits(html: string): void {
  // ASCII-only folding preserves source indexes; full Unicode lowercasing can expand code points.
  const lowerHtml = html.replace(/[A-Z]/g, (character) => character.toLowerCase());
  const openElements: string[] = [];
  let elementCount = 0;
  let index = 0;

  while (index < html.length) {
    const tagStart = html.indexOf("<", index);
    if (tagStart < 0) break;

    if (html.startsWith("<!--", tagStart)) {
      const commentEnd = html.indexOf("-->", tagStart + 4);
      if (commentEnd < 0) break;
      index = commentEnd + 3;
      continue;
    }

    let cursor = tagStart + 1;
    const closing = html[cursor] === "/";
    if (closing) cursor += 1;
    if (!isTagNameCharacter(html[cursor])) {
      index = tagStart + 1;
      continue;
    }

    const nameStart = cursor;
    while (isTagNameCharacter(html[cursor])) cursor += 1;
    const tagName = lowerHtml.slice(nameStart, cursor);
    const tagEnd = findTagEnd(html, cursor);
    if (tagEnd < 0) break;

    if (closing) {
      if (openElements.at(-1) === tagName) openElements.pop();
      index = tagEnd + 1;
      continue;
    }

    elementCount += 1;
    if (elementCount > MAX_HTML_ELEMENTS) {
      throw new Error(`HTML exceeds the ${MAX_HTML_ELEMENTS}-element limit`);
    }

    // In HTML syntax a trailing slash is ignored for non-void elements (`<div/>` still nests).
    // Treat it as self-closing only through the void-element list so the preflight matches
    // linkedom's HTML parser rather than XML rules.
    if (!VOID_ELEMENTS.has(tagName)) {
      openElements.push(tagName);
      if (openElements.length > MAX_HTML_NESTING_DEPTH) {
        throw new Error(
          `HTML exceeds the ${MAX_HTML_NESTING_DEPTH}-level nesting limit`,
        );
      }
    }

    if (RAW_TEXT_ELEMENTS.has(tagName)) {
      const rawTextEnd = lowerHtml.indexOf(`</${tagName}`, tagEnd + 1);
      if (rawTextEnd < 0) break;
      index = rawTextEnd;
      continue;
    }
    index = tagEnd + 1;
  }
}

/** Apply linkedom polyfills that Defuddle expects (getComputedStyle, styleSheets). */
export function parseLinkedomHTML(html: string, url?: string): Document {
  const { document } = parseHTML(html);
  const doc = document as Document & Record<string, unknown>;
  const defaultView = doc.defaultView as
    | (Window & {
        getComputedStyle?: (
          elt: Element,
          pseudoElt?: string | null,
        ) => CSSStyleDeclaration;
      })
    | undefined;

  if (!(doc as { styleSheets?: unknown }).styleSheets) {
    (doc as { styleSheets?: unknown }).styleSheets =
      [] as unknown as StyleSheetList;
  }

  if (defaultView && !defaultView.getComputedStyle) {
    defaultView.getComputedStyle = (() => ({
      display: "",
    })) as unknown as typeof defaultView.getComputedStyle;
  }

  if (url) {
    (doc as { URL?: string }).URL = url;
  }

  return document;
}
