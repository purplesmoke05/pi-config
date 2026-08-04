/** Small local replacements for lodash/deburr and mime-types. */

export function deburr(value: string): string {
  return value.normalize("NFKD").replace(/\p{Diacritic}/gu, "");
}

const MIME_EXTENSIONS: Record<string, string> = {
  "application/epub+zip": "epub",
  "application/gzip": "gz",
  "application/javascript": "js",
  "application/json": "json",
  "application/pdf": "pdf",
  "application/rtf": "rtf",
  "application/wasm": "wasm",
  "application/vnd.rar": "rar",
  "application/vnd.ms-excel": "xls",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.ms-word": "doc",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/zip": "zip",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "video/mp4": "mp4",
  "text/css": "css",
  "text/csv": "csv",
  "text/html": "html",
  "text/javascript": "js",
  "text/markdown": "md",
  "text/plain": "txt",
  "text/xml": "xml",
};

export function extensionForMimeType(value: string): string | undefined {
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (MIME_EXTENSIONS[normalized]) return MIME_EXTENSIONS[normalized];
  if (normalized.endsWith("+json")) return "json";
  if (normalized.endsWith("+xml")) return "xml";
  if (normalized.startsWith("text/")) return "txt";
  return undefined;
}
