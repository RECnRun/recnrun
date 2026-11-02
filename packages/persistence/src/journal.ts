import { mkdir, open, readFile, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { parseJournalEvent, type Event, type GapPayload } from "@recnrun/protocol";

/** Appends events to a run's `events.jsonl`, one validated JSON line each, in call order. */
export interface JournalWriter {
  readonly path: string;
  /** Resolves once the line is written; rejects an event that is not a journal event. */
  append(event: Event): Promise<void>;
  /** Waits for every pending line, flushes the file to disk, and closes it. */
  close(): Promise<void>;
}

/** A journal as read back: a truncated last line is dropped and reported as a gap. */
export interface JournalContents {
  events: Event[];
  gap?: GapPayload;
  truncatedBytes?: number;
}

/** A complete line of the journal is not a journal event; only the last line may be partial. */
export class JournalFileError extends Error {
  readonly path: string;
  constructor(path: string, detail: string) {
    super(`${path} is not a readable journal: ${detail}.`);
    this.name = "JournalFileError";
    this.path = path;
  }
}

/** An earlier write to the journal failed, so it accepts no more lines (`journal-failed`). */
export class JournalFailedError extends Error {
  constructor(path: string, cause: unknown) {
    super(`journal-failed: ${path} stopped after a write error.`, { cause });
    this.name = "JournalFailedError";
  }
}

const NEWLINE = 0x0a;
const TAIL_CHUNK = 65_536;

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

// Searches backwards in chunks, so reopening a long journal does not read all of it.
async function lastLineEnd(handle: FileHandle, size: number): Promise<number> {
  let end = size;
  while (end > 0) {
    const start = Math.max(0, end - TAIL_CHUNK);
    const buffer = Buffer.alloc(end - start);
    await handle.read(buffer, 0, buffer.length, start);
    const index = buffer.lastIndexOf(NEWLINE);
    if (index !== -1) return start + index + 1;
    end = start;
  }
  return 0;
}

// A crash can leave a partial last line; cutting it keeps the next line from joining it.
async function dropTruncatedTail(handle: FileHandle): Promise<void> {
  const { size } = await handle.stat();
  if (size === 0) return;
  const last = Buffer.alloc(1);
  await handle.read(last, 0, 1, size - 1);
  if (last[0] === NEWLINE) return;
  await handle.truncate(await lastLineEnd(handle, size));
}

// Closes the handle without letting a second failure hide the first, then rethrows the first.
async function releaseAfter(handle: FileHandle, error: unknown): Promise<never> {
  await handle.close().catch(() => undefined);
  throw error;
}

/** The file opener; tests inject one whose handle fails on demand. */
export type OpenFile = (path: string, flags: "a+") => Promise<FileHandle>;

/** Opens (creating it and its folder) the journal at `path` for appending. */
export async function openJournal(path: string, openFile: OpenFile = open): Promise<JournalWriter> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await openFile(path, "a+");
  await dropTruncatedTail(handle).catch((error: unknown) => releaseAfter(handle, error));
  let tail: Promise<void> = Promise.resolve();
  let failure: unknown;
  // A failed write may have left a partial line, so nothing more is appended after it.
  const write = async (line: string) => {
    if (failure !== undefined) throw new JournalFailedError(path, failure);
    try {
      await handle.appendFile(line, "utf8");
    } catch (error) {
      failure = error;
      throw error;
    }
  };
  return {
    path,
    append(event) {
      const parsed = parseJournalEvent(event);
      if (!parsed.ok)
        return Promise.reject(new Error(`Refusing a journal line: ${parsed.message}`));
      // One write per line, chained, so concurrent appends never interleave.
      const written = tail.then(() => write(`${JSON.stringify(parsed.event)}\n`));
      tail = written.catch(() => undefined);
      return written;
    },
    async close() {
      await tail;
      if (failure !== undefined) {
        await handle.close();
        throw new JournalFailedError(path, failure);
      }
      await handle.sync().catch((error: unknown) => releaseAfter(handle, error));
      await handle.close();
    },
  };
}

function parseLine(path: string, line: string, number: number): Event {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    throw new JournalFileError(path, `line ${number} is not JSON`);
  }
  const parsed = parseJournalEvent(json);
  if (!parsed.ok) throw new JournalFileError(path, `line ${number}: ${parsed.message}`);
  return parsed.event;
}

/** Reads every event of the journal at `path`; an absent journal has none. */
export async function readJournal(path: string): Promise<JournalContents> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return { events: [] };
    throw error;
  }
  const lines = text.split("\n");
  // The writer ends every line with a newline, so text after the last one is a partial line.
  const partial = lines.pop() ?? "";
  const events = lines.map((line, index) => parseLine(path, line, index + 1));
  if (partial === "") return { events };
  const lastSeq = events.at(-1)?.seq;
  return {
    events,
    gap: { reason: "journal-truncated", ...(lastSeq !== undefined && { lastSeq }) },
    truncatedBytes: Buffer.byteLength(partial),
  };
}
