// Writers that keep writing while RECnRun captures (S3.10). Page scripts are serialized with
// toString(), so they must not close over imports or each other.
import { literal } from "./app-pages.ts";

/** One writer's database as a restored page first reads it, before any writer runs again. */
export interface WriterRead {
  count: number;
  max: number | null;
  /** Whether the keys are exactly 1…count, so no write in the middle went missing. */
  contiguous: boolean;
  tags: string[];
  meta: { tag: string; seq: number } | null;
}

/** What `/writers/` reads first: each writer's database (null when absent) and the page's seq. */
export interface WritersFirst {
  databases: Record<string, WriterRead | null>;
  pageSeq: number | null;
}

/** One writer: its name, the session tag it writes, the log run, and when it stops. */
interface WriterOptions {
  name: string;
  tag: string;
  run: string;
  mirror: boolean;
  until: number;
}

/** A write a writer reported once its transaction completed. */
export interface WriterBeacon {
  writer: string;
  tag: string;
  seq: number;
  committed: number;
}

/**
 * Every ~10 ms until `until`, writes `{ tag, seq }` under key `seq` and as `meta.last` of
 * `writers-<name>` in one transaction, then reports it. `mirror` also writes the seq to
 * localStorage and to a second database, each on its own, as an app with several stores would.
 */
async function writeLoop(options: WriterOptions) {
  const { name, tag, run, mirror, until } = options;
  const settled = (tx: IDBTransaction) =>
    new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("aborted"));
    });
  const open = (database: string) =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(database, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("records");
        request.result.createObjectStore("meta");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("open failed"));
    });
  const write = async (db: IDBDatabase, seq: number) => {
    const tx = db.transaction(["records", "meta"], "readwrite");
    tx.objectStore("records").put({ tag, seq }, seq);
    tx.objectStore("meta").put({ tag, seq }, "last");
    await settled(tx);
  };
  const db = await open(`writers-${name}`);
  const second = mirror ? await open("writers-mirror") : undefined;
  const read = db.transaction("meta").objectStore("meta").get("last");
  await settled(read.transaction as IDBTransaction);
  let seq = (read.result as { seq: number } | undefined)?.seq ?? 0;
  while (Date.now() < until) {
    seq += 1;
    await write(db, seq);
    const committed = Date.now();
    if (second) {
      localStorage.setItem("page-seq", String(seq));
      await write(second, seq);
    }
    const body = JSON.stringify({ writer: name, tag, seq, committed });
    void fetch(`/__log?run=${encodeURIComponent(run)}`, { method: "POST", body, keepalive: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Reads every writer's database in one readonly transaction each, creating none. */
async function readWriters(): Promise<WritersFirst> {
  const names = new Set((await indexedDB.databases()).map(({ name }) => name));
  const readOne = (database: string) =>
    new Promise<WriterRead>((resolve, reject) => {
      const request = indexedDB.open(database);
      request.onerror = () => reject(request.error ?? new Error("open failed"));
      request.onsuccess = () => {
        const tx = request.result.transaction(["records", "meta"]);
        const keys = tx.objectStore("records").getAllKeys();
        const values = tx.objectStore("records").getAll();
        const meta = tx.objectStore("meta").get("last");
        tx.oncomplete = () => {
          request.result.close();
          const seqs = (keys.result as number[]).toSorted((a, b) => a - b);
          const tags = new Set((values.result as { tag: string }[]).map(({ tag }) => tag));
          resolve({
            count: seqs.length,
            max: seqs.at(-1) ?? null,
            contiguous: seqs.every((seq, index) => seq === index + 1),
            tags: [...tags].toSorted(),
            meta: (meta.result as WriterRead["meta"] | undefined) ?? null,
          });
        };
      };
    });
  const databases: WritersFirst["databases"] = {};
  for (const writer of ["page", "worker", "sw", "mirror"]) {
    const database = `writers-${writer}`;
    databases[writer] = names.has(database) ? await readOne(database) : null;
  }
  const pageSeq = localStorage.getItem("page-seq");
  return { databases, pageSeq: pageSeq === null ? null : Number(pageSeq) };
}

interface WritersWindow {
  __writers: { first: Promise<WritersFirst>; start: (tag: string) => Promise<void> };
}

/** The page: reads first, then on `start` runs its own writer and starts the two others. */
function writersPage(run: string, write: typeof writeLoop, read: typeof readWriters): void {
  const scope = window as unknown as WritersWindow;
  scope.__writers = {
    first: read(),
    start: async (tag) => {
      const message = { tag, run, until: Date.now() + 120_000 };
      new Worker("/writers/worker.js").postMessage(message);
      const registration = await navigator.serviceWorker.register("/writers/sw.js", {
        scope: "/writers/",
      });
      const active = registration.active ?? (await navigator.serviceWorker.ready).active;
      active?.postMessage(message);
      void write({ name: "page", tag, run, mirror: true, until: message.until });
    },
  };
}

/** `/writers/?run=`: no writer runs until the test calls `__writers.start(tag)`. */
export function writersHtml(run: string): string {
  const args = `${literal(run)}, ${writeLoop.toString()}, ${readWriters.toString()}`;
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Writers</title>` +
    `<script>(${writersPage.toString()})(${args});</script>` +
    `</head><body><h1>Writers</h1></body></html>`
  );
}

/** The dedicated worker: one writer, started by the page's message. */
export const writersWorker = `self.onmessage = (event) => {
  void (${writeLoop.toString()})({ ...event.data, name: "worker", mirror: false });
};`;

/** The Service Worker: one writer, kept alive by `waitUntil` while it writes. */
export const writersServiceWorker = `self.oninstall = () => self.skipWaiting();
self.onactivate = (event) => event.waitUntil(self.clients.claim());
self.onmessage = (event) => {
  event.waitUntil((${writeLoop.toString()})({ ...event.data, name: "sw", mirror: false }));
};`;
