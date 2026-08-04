import { Worker } from "node:worker_threads";
import type { ExtractedContent } from "./types.ts";

interface SerializedWorkerError {
  name?: string;
  message?: string;
  stack?: string;
}

type DefuddleWorkerMessage =
  | { ok: true; result: ExtractedContent }
  | { ok: false; error: SerializedWorkerError };

function deserializeWorkerError(serialized: SerializedWorkerError): Error {
  const error = new Error(serialized.message ?? "Defuddle worker failed");
  error.name = serialized.name ?? "Error";
  if (serialized.stack) error.stack = serialized.stack;
  return error;
}

/** Run synchronous DOM parsing and Defuddle extraction outside Pi's event loop. */
export function extractDefuddleInWorker(
  html: string,
  url: string,
  options: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ExtractedContent> {
  signal?.throwIfAborted();
  const worker = new Worker(new URL("./defuddle-worker.mjs", import.meta.url), {
    execArgv: [],
    workerData: { html, url, options },
    resourceLimits: {
      maxOldGenerationSizeMb: 256,
      stackSizeMb: 8,
    },
  });

  return new Promise<ExtractedContent>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      worker.removeListener("message", onMessage);
      worker.removeListener("error", onError);
      worker.removeListener("exit", onExit);
    };
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate();
      complete();
    };
    const onMessage = (message: DefuddleWorkerMessage) => {
      if (message.ok) {
        finish(() => resolve(message.result));
      } else {
        finish(() => reject(deserializeWorkerError(message.error)));
      }
    };
    const onError = (error: Error) => finish(() => reject(error));
    const onExit = (code: number) => {
      finish(() =>
        reject(
          new Error(
            `Defuddle worker exited before returning a result (code ${code})`,
          ),
        ),
      );
    };
    const onAbort = () => {
      const reason = signal?.reason;
      finish(() =>
        reject(
          reason instanceof Error
            ? reason
            : new DOMException("Defuddle extraction aborted", "AbortError"),
        ),
      );
    };

    worker.once("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
