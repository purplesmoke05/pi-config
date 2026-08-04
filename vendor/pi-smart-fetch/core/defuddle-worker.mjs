import { parentPort, workerData } from "node:worker_threads";
import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";

if (!parentPort) throw new Error("Defuddle worker requires a parent port");

function parseDocument(html, url) {
  const { document } = parseHTML(html);
  const defaultView = document.defaultView;

  if (!document.styleSheets) document.styleSheets = [];
  if (defaultView && !defaultView.getComputedStyle) {
    defaultView.getComputedStyle = () => ({ display: "" });
  }
  document.URL = url;
  return document;
}

function serializeError(error) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: "Error", message: String(error) };
}

try {
  const { html, url, options } = workerData;
  if (typeof html !== "string" || typeof url !== "string") {
    throw new TypeError("Invalid Defuddle worker input");
  }

  const extracted = await Defuddle(parseDocument(html, url), url, {
    markdown: options?.markdown === true,
    removeImages: options?.removeImages === true,
    includeReplies: options?.includeReplies,
    useAsync: false,
  });

  parentPort.postMessage({
    ok: true,
    result: {
      content: extracted.content,
      wordCount: Number(extracted.wordCount ?? 0),
      title: extracted.title,
      author: extracted.author,
      published: extracted.published,
      site: extracted.site,
      language: extracted.language,
      extractorType: extracted.extractorType,
    },
  });
} catch (error) {
  parentPort.postMessage({ ok: false, error: serializeError(error) });
}
