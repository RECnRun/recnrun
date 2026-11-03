import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

/** A log file that rolls over to `<name>.1` … `<name>.<keep>` once it would pass `maxBytes`. */
export interface RotatingLog {
  readonly path: string;
  /** Appends one complete line (with its newline); lines are written in call order. */
  append(line: string): Promise<void>;
  /** Waits for every pending line. */
  close(): Promise<void>;
}

export interface RotatingLogOptions {
  folder: string;
  name: string;
  maxBytes: number;
  /** How many rotated files to keep besides the current one. */
  keep: number;
}

const missing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (missing(error)) return 0;
    throw error;
  }
}

async function moveIfPresent(from: string, to: string): Promise<void> {
  await rename(from, to).catch((error: unknown) => {
    if (!missing(error)) throw error;
  });
}

/** Opens the log `<folder>/<name>` (mode 0600, folder 0700), created on the first line. */
export function openRotatingLog({ folder, name, maxBytes, keep }: RotatingLogOptions): RotatingLog {
  const path = join(folder, name);
  // Unknown until the first append reads what an earlier process left in the file.
  let size: number | undefined;
  let tail: Promise<void> = Promise.resolve();
  const rotate = async () => {
    // The oldest file is overwritten by the next one down, so at most `keep` remain.
    for (let index = keep - 1; index >= 1; index -= 1)
      await moveIfPresent(`${path}.${index}`, `${path}.${index + 1}`);
    await moveIfPresent(path, `${path}.1`);
    size = 0;
  };
  const write = async (line: string) => {
    if (size === undefined) {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      size = await sizeOf(path);
    }
    const bytes = Buffer.byteLength(line);
    if (size > 0 && size + bytes > maxBytes) await rotate();
    await appendFile(path, line, { mode: 0o600 });
    size += bytes;
  };
  return {
    path,
    append(line) {
      const written = tail.then(() => write(line));
      tail = written.catch(() => undefined);
      return written;
    },
    close: () => tail,
  };
}
