import { Defuddle } from "defuddle/node";
import { extractDefuddleInWorker } from "./isolated-defuddle.ts";
import { safeFetch } from "./safe-http.ts";
import type { FetchDependencies } from "./types.ts";

export const runtimeDependencies: FetchDependencies = {
  fetch: safeFetch,
  defuddle: Defuddle,
  defuddleHtml: extractDefuddleInWorker,
  getProfiles: () => [],
};
