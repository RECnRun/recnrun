import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openPage } from "../browser/fixtures/cdp-client.ts";
import type { PageSession } from "../browser/fixtures/cdp-client.ts";
import type { Installed } from "./e1-samples.ts";
import type { Cell, Sample } from "./outcome.ts";
import { appendVerdict } from "./verdicts.ts";
import type { Verdict } from "./verdicts.ts";

/*
 * The samples of E3 (POC PLAN.md P1.4), shared by the lab spec and its host twin: a fresh root with
 * the poc-d0 build, and file:// reads through `window.__poc.readFile` in its diagnostics page.
 */

const EXTENSION = fileURLToPath(new URL("../../apps/extension/src/", import.meta.url));
const READY_TIMEOUT_MS = 10_000;
const READY_POLL_MS = 100;
const PREVIEW = 200;
const LISTED = ["a.json", "b.txt"];

const PROBE = "e3-probe.txt";
export const LISTING_REASON = "no dedicated experiment and validated parser (§6.3)";
// Same length on purpose: a cache keyed on size and a coarse mtime would miss the change.
const VERSION_A = "RECnRun E3 probe, version A\n";
const VERSION_B = "RECnRun E3 probe, version B\n";
const VERSION_C = "RECnRun E3 probe, version C\n";

type Via = "page" | "offscreen";
type Read = { ok: true; status: number; text: string } | { ok: false; error: unknown };

/** A running install with the root it lives on; `dispose` quits Chrome and removes the root. */
interface E3Install extends Installed {
  root: string;
  dispose(): Promise<void>;
}

export interface E3Cells {
  fresh(): Promise<E3Install>;
}

/** Evaluates `NAME = <digits> [* <digits>]...` in a source file, so the harness never copies it. */
async function constantOf(file: string, name: string): Promise<number> {
  const source = await readFile(join(EXTENSION, file), "utf8");
  const found = new RegExp(`const ${name} = ([\\d_]+(?:\\s*\\*\\s*[\\d_]+)*);`).exec(source);
  if (!found?.[1]) throw new Error(`${name} not found in ${file}`);
  return found[1]
    .split("*")
    .reduce((product, part) => product * Number(part.replaceAll("_", "")), 1);
}

/** The folder rendezvous' poll interval and presence TTL, read from the extension's source. */
async function rendezvousTiming(): Promise<{ pollMs: number; ttlMs: number }> {
  const pollMs = await constantOf("offscreen/folder-watch.ts", "POLL_MS");
  const ttlMs = await constantOf("p2p/folder-rendezvous.ts", "PRESENCE_TTL_MS");
  return { pollMs, ttlMs };
}

async function diagnostics(installed: Installed): Promise<PageSession> {
  const url = `chrome-extension://${installed.extensionId}/diagnostics.html`;
  const page = await openPage(installed.client, url);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while ((await page.evaluate("typeof window.__poc?.readFile")) !== "function") {
    if (Date.now() > deadline) {
      await page.close();
      throw new Error("window.__poc.readFile is not defined in diagnostics.html");
    }
    await delay(READY_POLL_MS);
  }
  return page;
}

const readIn = async (page: PageSession, url: string, options: Record<string, string>) =>
  (await page.evaluate(
    `window.__poc.readFile(${JSON.stringify(url)}, ${JSON.stringify(options)})`,
  )) as Read;

/** What a read returned, without the whole text. */
const summary = (read: Read) =>
  read.ok ? { ok: true, status: read.status, text: read.text.slice(0, PREVIEW) } : read;

/** A listing's first characters, its length, and whether it names the folder's two files. */
const listing = (read: Read) => {
  if (!read.ok) return read;
  const names = Object.fromEntries(LISTED.map((name) => [name, read.text.includes(name)]));
  return { ...summary(read), length: read.text.length, names };
};

async function withPage(
  cells: E3Cells,
  run: (page: PageSession, install: E3Install) => Promise<Sample>,
): Promise<Sample> {
  const install = await cells.fresh();
  try {
    const page = await diagnostics(install);
    try {
      return await run(page, install);
    } finally {
      await page.close();
    }
  } finally {
    await install.dispose();
  }
}

/** One read of the probe in `via`; the offscreen tries XMLHttpRequest when its fetch fails. */
export const fetchSample = (cells: E3Cells, via: Via): Promise<Sample> =>
  withPage(cells, async (page, { root, extensionId }) => {
    const path = join(root, PROBE);
    await writeFile(path, VERSION_A);
    const url = pathToFileURL(path).href;
    const read = await readIn(page, url, { via });
    const matches = read.ok && read.text === VERSION_A;
    const observation: Record<string, unknown> = { extensionId, via, read: summary(read), matches };
    if (!matches && via === "offscreen") {
      const xhr = await readIn(page, url, { via, api: "xhr" });
      observation.alternative = {
        api: "xhr",
        read: summary(xhr),
        matches: xhr.ok && xhr.text === VERSION_A,
      };
    }
    if (matches) return { ok: true, observation, steps: [] };
    return { ok: false, error: `${via} fetch did not read the probe`, observation, steps: [] };
  });

interface Seen {
  /** Polls after the immediate re-read until the change showed; null when it never did. */
  polls: number | null;
  first: Read;
  elapsedMs: number;
}

/** Re-reads right after the change, then once per poll until the TTL, until the new text shows. */
async function untilSeen(
  read: () => Promise<Read>,
  expected: string,
  timing: { pollMs: number; ttlMs: number },
) {
  const start = Date.now();
  const first = await read();
  let last = first;
  for (let polls = 0; polls * timing.pollMs <= timing.ttlMs; polls++) {
    if (polls > 0) {
      await delay(timing.pollMs);
      last = await read();
    }
    if (last.ok && last.text === expected) return { polls, first, elapsedMs: Date.now() - start };
  }
  return { polls: null, first, elapsedMs: Date.now() - start };
}

/** Changes the probe from Node twice: the default mode must see the first change within one poll; no-store reads the second. */
export const cacheSample = (cells: E3Cells, via: Via): Promise<Sample> =>
  withPage(cells, async (page, { root, extensionId }) => {
    const timing = await rendezvousTiming();
    const path = join(root, PROBE);
    const url = pathToFileURL(path).href;
    await writeFile(path, VERSION_A);
    const before = await readIn(page, url, { via });
    await writeFile(path, VERSION_B);
    const byDefault: Seen = await untilSeen(() => readIn(page, url, { via }), VERSION_B, timing);
    await writeFile(path, VERSION_C);
    const noStore: Seen = await untilSeen(
      () => readIn(page, url, { via, cache: "no-store" }),
      VERSION_C,
      timing,
    );
    const seenByDefault = byDefault.polls !== null && byDefault.polls <= 1;
    const noStoreNeeded = !seenByDefault && noStore.polls !== null && noStore.polls <= 1;
    const report = (seen: Seen) => ({
      polls: seen.polls,
      elapsedMs: seen.elapsedMs,
      first: summary(seen.first),
    });
    const observation = {
      extensionId,
      via,
      pollMs: timing.pollMs,
      ttlMs: timing.ttlMs,
      before: summary(before),
      byDefault: report(byDefault),
      noStore: report(noStore),
      noStoreNeeded,
    };
    if (before.ok && before.text === VERSION_A && seenByDefault)
      return { ok: true, observation, steps: [] };
    const error = `${via}: the default cache mode saw the change after ${String(byDefault.polls)} polls (no-store: ${String(noStore.polls)})`;
    return { ok: false, error, observation, steps: [] };
  });

/** What `fetch("file:///<dir>/")` returns in each context, for the next phase to decide on. */
export const listingObservation = (cells: E3Cells): Promise<Record<string, unknown>> =>
  withPage(cells, async (page, { root }) => {
    const directory = join(root, "e3-listing");
    await mkdir(directory);
    for (const name of LISTED) await writeFile(join(directory, name), name);
    const url = `${pathToFileURL(directory).href}/`;
    const inPage = listing(await readIn(page, url, { via: "page" }));
    const offscreen = listing(await readIn(page, url, { via: "offscreen" }));
    return { ok: true, observation: { url, page: inPage, offscreen }, steps: [] };
  }).then((sample) => sample.observation);

/** `unavailable` with what was seen anyway, so the observation reaches the verdict file. */
export async function recordUnavailableSeen(
  cell: Cell,
  reason: string,
  observation: Record<string, unknown>,
  directory?: string,
): Promise<Verdict> {
  const verdict: Verdict = {
    ...cell,
    verdict: "unavailable",
    error: reason,
    samples: 1,
    gestures: 0,
    steps: [],
    observations: [observation],
  };
  await appendVerdict(verdict, directory);
  console.log(JSON.stringify(verdict));
  return verdict;
}
