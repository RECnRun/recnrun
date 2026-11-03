// Capture overhead benchmark: the fixture under no instrumentation, Normal, and Deep (PLAN.md F3.9).
// It launches its own Google Chrome on a fresh profile; run it in Docker with `vp run bench`.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { instrument } from "../packages/adapter/src/index.ts";
import { openBlobStore, openJournal } from "../packages/persistence/src/index.ts";
import { launchChrome } from "../tests/browser/fixtures/launch-chrome.ts";
import {
  accountLoss,
  checkBudget,
  createLossTally,
  pairLags,
  parseBenchArgs,
  percentiles,
  renderSummary,
  shapeReport,
} from "./bench-report.mjs";
import {
  PAGE_PROBE,
  readPage,
  round,
  sizeOf,
  startChromeProbe,
  startFixture,
  startNodeProbe,
  versionsOf,
} from "./bench-probes.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const TYPED = "bench";
const HEAP_PHASE_TIMEOUT_MS = 180_000;
// Lets the hook report what it lost on pagehide before the capture stops.
const SETTLE_MS = 500;

// The Deep level itself is F6.5; until then Deep turns the adapter's own knobs to their deepest.
const CAPTURE = {
  normal: { notes: "Normal capture as a recording session runs it, bodies in a blob store." },
  deep: {
    notes:
      "Normal with a 4000-message hook buffer and the cookie jar read every 250 ms; the Deep level proper (F6.5) will replace this.",
    observerBuffer: 4_000,
    cookiePollMs: 250,
  },
};

const isHookClick = (event) =>
  event.category === "dom" && event.type === "click" && event.producer.startsWith("hook:");

/** Journals every captured event as a recording does, counting it without keeping it. */
async function startCapture(endpoint, mode, folder) {
  const { observerBuffer, cookiePollMs } = CAPTURE[mode];
  const journal = await openJournal(join(folder, "events.jsonl"));
  const blobs = await openBlobStore({ folder: join(folder, "blobs") });
  const tally = createLossTally();
  const clickJournaledAt = [];
  let tail = Promise.resolve();
  let journalErrors = 0;
  const onEvent = (event) => {
    tally.add(event);
    const written = journal.append(event).then(() => {
      if (isHookClick(event)) clickJournaledAt.push(Date.now());
    });
    tail = written.catch(() => void (journalErrors += 1));
  };
  const handle = await instrument(endpoint, {
    ...(observerBuffer !== undefined && { observerBuffer }),
    capture: { runId: `bench-${mode}`, blobs, onEvent, ...(cookiePollMs && { cookiePollMs }) },
  });
  return {
    tally,
    clickJournaledAt,
    flush: () => tail,
    async finish() {
      await handle.settled();
      await delay(SETTLE_MS);
      await handle.settled();
      handle.stop();
      await tail;
      await journal.close();
      return { journalErrors };
    },
  };
}

async function withChrome(run) {
  const chrome = await launchChrome();
  try {
    const browser = await chromium.connectOverCDP(chrome.wsEndpoint);
    try {
      return await run(chrome, browser);
    } finally {
      await browser.close();
    }
  } finally {
    await chrome.close();
  }
}

async function openBurst(browser, { origin, burst }) {
  const [context = await browser.newContext()] = browser.contexts();
  const page = await context.newPage();
  await page.addInitScript(PAGE_PROBE);
  await page.goto(`${origin}/routes/burst?count=${burst}`);
  await page.waitForFunction(() => window.__fixture?.ready === true);
  return page;
}

/** One burst click and a typed word per cycle, until `done()` answers true. */
async function drive(page, done, onCycle = async () => {}) {
  const button = page.getByTestId("burst-button");
  const input = page.getByTestId("burst-input");
  const counts = { bursts: 0, keystrokes: 0 };
  while (!done()) {
    await button.click();
    await input.focus();
    await page.keyboard.type(TYPED);
    counts.bursts += 1;
    counts.keystrokes += TYPED.length;
    await onCycle(counts);
  }
  return counts;
}

function captureFields(mode, capture, seen, seconds) {
  if (!capture) return { journalLagMs: null, events: null, loss: null };
  const totals = capture.tally.totals();
  return {
    journalLagMs: pairLags(seen.clickAt, capture.clickJournaledAt),
    events: { journaled: totals.journaled, perSecond: round(totals.journaled / seconds) },
    loss: accountLoss(totals, seen.inputs),
  };
}

/** Drives the burst route for `seconds` in one mode on a Chrome of its own. */
async function runMode(mode, context) {
  return withChrome(async (chrome, browser) => {
    context.chrome ??= chrome.version;
    const folder = join(context.traces, mode);
    const capture = mode === "none" ? null : await startCapture(chrome.wsEndpoint, mode, folder);
    const page = await openBurst(browser, context);
    const chromeProbe = await startChromeProbe(browser, page);
    const nodeProbe = startNodeProbe();
    const startedAt = performance.now();
    const deadline = Date.now() + context.seconds * 1000;
    const progress = async (counts) =>
      context.onCycle?.({ mode, counts, tally: capture?.tally, folder });
    const interactions = await drive(page, () => Date.now() >= deadline, progress);
    const seconds = round((performance.now() - startedAt) / 1000, 2);
    const [chromeMetrics, node, seen] = [await chromeProbe(), nodeProbe(), await readPage(page)];
    await page.goto("about:blank");
    const { journalErrors = 0 } = (await capture?.finish()) ?? {};
    const journalBytes = await sizeOf(join(folder, "events.jsonl"));
    const blobBytes = await sizeOf(join(folder, "blobs"));
    return {
      mode,
      notes: CAPTURE[mode]?.notes ?? "No RECnRun instrumentation attached; the driver only.",
      seconds,
      interactions,
      latencyMs: { click: percentiles(seen.click), key: percentiles(seen.key) },
      ...captureFields(mode, capture, seen, seconds),
      journalErrors,
      node,
      chrome: chromeMetrics,
      trace: capture
        ? {
            journalBytes,
            blobBytes,
            totalBytes: journalBytes + blobBytes,
            bytesPerSecond: Math.round((journalBytes + blobBytes) / seconds),
          }
        : null,
    };
  });
}

function collectedHeap() {
  globalThis.gc?.();
  return process.memoryUsage().heapUsed;
}

/** Captures `heapEvents` events in Normal mode, then weighs the heap with the capture still live. */
async function measureHeap(context) {
  return withChrome(async (chrome, browser) => {
    context.chrome ??= chrome.version;
    const heapBeforeBytes = collectedHeap();
    const capture = await startCapture(chrome.wsEndpoint, "normal", join(context.traces, "memory"));
    const page = await openBurst(browser, context);
    const deadline = Date.now() + HEAP_PHASE_TIMEOUT_MS;
    const enough = () =>
      capture.tally.totals().journaled >= context.heapEvents || Date.now() >= deadline;
    const startedAt = performance.now();
    await drive(page, enough);
    await capture.flush();
    const heapUsedBytes = collectedHeap();
    const events = capture.tally.totals().journaled;
    await page.goto("about:blank");
    await capture.finish();
    return {
      ...checkBudget(heapUsedBytes, heapBeforeBytes),
      events,
      gcForced: typeof globalThis.gc === "function",
      seconds: round((performance.now() - startedAt) / 1000, 2),
    };
  });
}

const defaultOut = () => {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  // The test container exports test-results/, so a containerized run lands in .artifacts/docker/.
  const base = process.env.RECNRUN_TEST_CONTAINER === "1" ? "test-results" : ".artifacts";
  return join(ROOT, base, "bench", stamp);
};

/** Runs the benchmark and writes report.json and summary.md; `kind` and `onCycle` serve the soak. */
export async function runBench(options, { kind = "bench", onCycle } = {}) {
  const out = resolve(options.out ?? defaultOut());
  const traces = await mkdtemp(join(tmpdir(), "recnrun-bench-"));
  const fixture = await startFixture(ROOT);
  const context = { ...options, origin: fixture.origin, traces, onCycle, chrome: undefined };
  const startedAt = new Date().toISOString();
  try {
    // Weighed first, so the heap holds the capture and not what the modes left for the GC.
    const memory = options.heapEvents > 0 ? await measureHeap(context) : null;
    const modes = [];
    for (const mode of options.modes) modes.push(await runMode(mode, context));
    const report = shapeReport({
      kind,
      startedAt,
      finishedAt: new Date().toISOString(),
      options: { ...options, out },
      versions: await versionsOf(context.chrome),
      modes,
      memory,
    });
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(join(out, "summary.md"), renderSummary(report));
    return { report, out };
  } finally {
    fixture.stop();
    await rm(traces, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { report, out } = await runBench(parseBenchArgs(process.argv.slice(2)));
  console.log(renderSummary(report));
  console.log(`Report: ${join(out, "report.json")}`);
  const { lossAccounted, memoryBounded } = report.checks;
  if (!lossAccounted || memoryBounded === false) process.exitCode = 2;
}
