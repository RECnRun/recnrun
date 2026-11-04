import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openPage } from "../browser/fixtures/cdp-client.ts";
import type { PageSession } from "../browser/fixtures/cdp-client.ts";
import { cacheRun, summary, VERSIONS } from "./e3-cache.ts";
import type { Read } from "./e3-cache.ts";
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
const LISTED = ["a.json", "b.txt"];

const PROBE = "e3-probe.txt";
export const LISTING_REASON = "no dedicated experiment and validated parser (§6.3)";
const VERSION_A = VERSIONS[0] ?? "";

type Via = "page" | "offscreen";

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

/** The folder watch's poll interval, read from the extension's source. */
const pollInterval = () => constantOf("offscreen/folder-watch.ts", "POLL_MS");

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

/** Changes the probe A→B→C→D from Node, one poll apart; each change must show on the first read after it. */
export const cacheSample = (cells: E3Cells, via: Via): Promise<Sample> =>
  withPage(cells, async (page, { root, extensionId }) => {
    const pollMs = await pollInterval();
    const path = join(root, PROBE);
    const url = pathToFileURL(path).href;
    const run = await cacheRun({
      write: (text) => writeFile(path, text),
      read: (cache) => readIn(page, url, cache ? { via, cache } : { via }),
      wait: () => delay(pollMs),
    });
    const observation = { extensionId, via, pollMs, ...run.observation };
    if (run.problems.length === 0) return { ok: true, observation, steps: [] };
    return { ok: false, error: `${via}: ${run.problems.join("; ")}`, observation, steps: [] };
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
