import { appendFile, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "@recnrun/protocol";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { JournalFileError, openJournal, readJournal } from "../src/index.ts";

const event = (seq: number): Event => ({
  schemaVersion: 1,
  id: `cdp:S1#${seq}`,
  runId: "run-1",
  seq,
  source: "S1",
  producer: "cdp:S1",
  timestamp: "2026-11-02T10:00:00.000Z",
  targetId: "T1",
  frameId: "T1",
  documentId: null,
  category: "console",
  type: "api",
  payload: { level: "log", args: [`message ${seq}`] },
});

let folder = "";
let path = "";
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "recnrun-journal-"));
  path = join(folder, "runs", "run-1", "events.jsonl");
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

test("appends one JSON line per event, in order, and reads them back", async () => {
  const journal = await openJournal(path);
  await Promise.all([1, 2, 3].map((seq) => journal.append(event(seq))));
  await journal.close();
  const text = await readFile(path, "utf8");
  expect(text.split("\n")).toHaveLength(4);
  expect(text.endsWith("\n")).toBe(true);
  expect(await readJournal(path)).toEqual({ events: [event(1), event(2), event(3)] });
});

test("refuses an invalid event and writes nothing", async () => {
  const journal = await openJournal(path);
  await expect(journal.append({ ...event(1), seq: -1 })).rejects.toThrow(/seq/);
  await journal.close();
  expect(await readFile(path, "utf8")).toBe("");
});

test("an absent journal reads as empty", async () => {
  expect(await readJournal(join(folder, "missing.jsonl"))).toEqual({ events: [] });
});

test("a truncated last line is tolerated and reported as a gap after the last event", async () => {
  const journal = await openJournal(path);
  await journal.append(event(1));
  await journal.append(event(2));
  await journal.close();
  const partial = JSON.stringify(event(3)).slice(0, 40);
  await appendFile(path, partial);
  expect(await readJournal(path)).toEqual({
    events: [event(1), event(2)],
    gap: { reason: "journal-truncated", lastSeq: 2 },
    truncatedBytes: Buffer.byteLength(partial),
  });
});

test("reopening drops a truncated tail, so the next line starts clean", async () => {
  const first = await openJournal(path);
  await first.append(event(1));
  await first.close();
  await appendFile(path, `${"x".repeat(70_000)}{"partial":`);
  const second = await openJournal(path);
  await second.append(event(2));
  await second.close();
  expect(await readJournal(path)).toEqual({ events: [event(1), event(2)] });
});

test("a journal whose only line is truncated reopens empty", async () => {
  const first = await openJournal(path);
  await first.close();
  await appendFile(path, '{"partial":');
  const second = await openJournal(path);
  await second.close();
  expect(await readFile(path, "utf8")).toBe("");
});

test("a broken line before the last is corruption, reported with its line number", async () => {
  const journal = await openJournal(path);
  await journal.append(event(1));
  await journal.close();
  await appendFile(path, `not json\n${JSON.stringify({ ...event(3), category: "x" })}\n`);
  await expect(readJournal(path)).rejects.toThrow(JournalFileError);
  await expect(readJournal(path)).rejects.toThrow(/line 2/);
  await writeFile(path, `${JSON.stringify({ ...event(3), category: "x" })}\n`);
  await expect(readJournal(path)).rejects.toThrow(/line 1: .*received "x"/);
});

/** A journal on a real file whose handle is wrapped by `wrap`, to inject I/O failures. */
async function journalWith(wrap: (handle: FileHandle) => Partial<FileHandle>) {
  return openJournal(path, async (file, flags) => {
    const handle = await open(file, flags);
    const overrides = wrap(handle);
    return new Proxy(handle, {
      get: (target, key) => {
        if (key in overrides) return Reflect.get(overrides, key);
        const value = Reflect.get(target, key) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
}

test("after a failed partial write every later append and close fail, and no line is glued on", async () => {
  const disk = new Error("ENOSPC: no space left on device");
  const writer = await journalWith((handle) => ({
    appendFile: async (data: string) => {
      await handle.appendFile(data.slice(0, 20));
      throw disk;
    },
  }));
  await expect(writer.append(event(1))).rejects.toBe(disk);
  await expect(writer.append(event(2))).rejects.toThrow(/journal-failed/);
  await expect(writer.close()).rejects.toThrow(/journal-failed/);
  expect(await readFile(path, "utf8")).toBe(JSON.stringify(event(1)).slice(0, 20));
  expect(await readJournal(path)).toMatchObject({
    events: [],
    gap: { reason: "journal-truncated" },
  });
});
