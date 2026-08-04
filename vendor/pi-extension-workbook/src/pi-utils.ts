import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number;
  signal?: NodeJS.Signals | null;
  error?: string;
  timedOut?: boolean;
};

export type RunCommandOptions = {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  maxStdoutChars?: number;
  maxStderrChars?: number;
};

function expandTilde(input: string): string {
  if (input === "~" || input === "$HOME") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  if (input.startsWith("$HOME/")) return path.join(os.homedir(), input.slice(6));
  return input;
}

export function resolveUserPath(input: string, cwd = process.cwd()): string {
  const expanded = expandTilde(input.trim().replace(/^@+/, ""));
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);
}

export function samePath(a: string, b: string): boolean {
  const normalize = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(a) === normalize(b);
}

export async function writeFileAtomic(filePath: string, data: string | NodeJS.ArrayBufferView): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.promises.writeFile(temporary, data);
    await fs.promises.rename(temporary, filePath);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function syncFile(filePath: string): Promise<void> {
  const handle = await fs.promises.open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await fs.promises.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

export function sha256Bytes(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function trimBuffer(value: string, maxChars: number | undefined): string {
  return !maxChars || value.length <= maxChars ? value : value.slice(-maxChars);
}

export function runCommand(command: string, args: string[] = [], options: RunCommandOptions = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = execFile(command, args, { cwd: options.cwd, env: options.env, timeout: options.timeoutMs }, (error, stdout, stderr) => {
      const exitCode = error && "code" in error && typeof error.code === "number" ? error.code : error ? 1 : 0;
      finish({
        ok: !error,
        stdout: trimBuffer(String(stdout ?? ""), options.maxStdoutChars),
        stderr: trimBuffer(String(stderr ?? ""), options.maxStderrChars),
        exitCode,
        signal: error && "signal" in error ? error.signal as NodeJS.Signals | null : null,
        error: error instanceof Error ? error.message : undefined,
        timedOut: error && "killed" in error ? Boolean(error.killed) : false,
      });
    });
    child.on("error", (error) => finish({ ok: false, stdout: "", stderr: "", error: error.message, exitCode: 1 }));
  });
}
