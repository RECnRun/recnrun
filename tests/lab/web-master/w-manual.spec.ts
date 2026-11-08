import { rm } from "node:fs/promises";
import { test } from "../../browser/fixtures/chrome.ts";
import type { StrictChrome } from "../../browser/fixtures/chrome.ts";
import { commandLine, launchBareWorker } from "./host-harness.ts";
import { startLabSignalRelay } from "./lab-signal-relay.ts";
import type { LabSignalRelay } from "./lab-signal-relay.ts";
import { background, provisionWorker, startWorker, until } from "./lifecycle-harness.ts";
import { startManualServer } from "./manual-server.ts";
import type { ManualServer } from "./manual-server.ts";
import { startTarget } from "./target-server.ts";
import type { Target } from "./target-server.ts";
import { provision } from "./trust-harness.ts";

/*
 * Manual mode of M-TW.16 (docs/poc/thin-worker/MANUAL_VALIDATION.md): this spec opens no master.
 * It prints a URL the owner opens in any Chrome (the personal Default included; nothing here
 * touches it), starts one worker on a throwaway root with only --silent-debugger-extension-api,
 * and prints what the worker's page sees while the owner clicks, types, scrolls, and drags.
 */

const manual = process.env.RECNRUN_W7_MANUAL === "1";
test.skip(!manual, "The manual cell runs with RECNRUN_W7_MANUAL=1");
test.setTimeout(30 * 60_000);

const headless = process.env.RECNRUN_W7_MANUAL_HEADLESS === "1";
const FORBIDDEN = /--remote-debugging|--enable-unsafe-extension-debugging/;
const AFTER_CLOSE_MS = 5_000;

interface Run {
  target: Target;
  relay: LabSignalRelay;
  server?: ManualServer;
  root?: string;
  worker?: StrictChrome;
  closedAt?: number;
  finished: boolean;
}

const say = (text: string) => console.log(`[manual] ${text}`);

/** Provisions a throwaway root for `masterKey`, then relaunches it with the single kept flag. */
async function startBare(run: Run, masterKey: JsonWebKey) {
  // A second Connect (a reload, a retry) replaces the worker rather than leaving one behind.
  await dropWorker(run);
  const { root, id } = await provisionWorker();
  run.root = root;
  const flagged = await startWorker(root, id, headless);
  const allowlist = [run.target.origin];
  try {
    await provision(flagged, { masterKey, allowlist, interactEnabled: true });
    await background(flagged, `lab.signal(${JSON.stringify(run.relay.origin)})`);
  } finally {
    await flagged.close();
  }
  run.worker = await launchBareWorker(root, headless);
  const forbidden = (await commandLine(run.worker.pid)).filter((flag) => FORBIDDEN.test(flag));
  say(
    `worker up: chrome=${run.worker.version} headless=${headless} debug flags=${forbidden.length}`,
  );
  return { target: run.target.origin };
}

async function link(run: Run, sdp: string) {
  run.relay.offer(sdp);
  return run.relay.answer(20_000);
}

/** Prints each new report of the worker's page as it arrives. */
function follow(run: Run) {
  let hits = 0;
  let reports = 0;
  const timer = setInterval(() => {
    for (const hit of run.target.hits.slice(hits)) say(`page click on #${hit.id} (${hit.path})`);
    hits = run.target.hits.length;
    for (const report of run.target.reports.slice(reports)) {
      if (report.type === "layout" || report.type === "input") continue;
      const { at: _at, ...rest } = report;
      say(`page ${JSON.stringify(rest)}`);
    }
    reports = run.target.reports.length;
  }, 250);
  return () => clearInterval(timer);
}

function summary(run: Run) {
  const of = (type: string) => run.target.reports.filter((report) => report.type === type);
  say("---- report ----");
  say(`counter clicks: ${run.target.hits.filter((hit) => hit.id === "count").length}`);
  say(`form submits: ${JSON.stringify(of("submit").map((report) => report.value))}`);
  say(`scroll max: ${Math.max(0, ...of("scroll").map((report) => report.page ?? 0))}`);
  say(`slider changes: ${JSON.stringify(of("change").map((report) => report.value))}`);
  const { closedAt } = run;
  const release = closedAt ? of("pointerup").find((report) => report.at >= closedAt) : undefined;
  if (!closedAt) say("tab closed mid-drag: not tried");
  else say(`release after tab close: ${release ? `${release.at - closedAt} ms` : "none seen"}`);
}

/** Closes the current worker and deletes its throwaway root. */
async function dropWorker(run: Run) {
  await run.worker?.close().catch(() => undefined);
  if (run.root) await rm(run.root, { recursive: true, force: true, maxRetries: 10 });
  run.worker = undefined;
  run.root = undefined;
}

async function teardown(run: Run) {
  await dropWorker(run);
  await run.server?.close();
  await run.relay.close();
  await run.target.close();
}

test("M-TW.16 manual: the owner drives a bare worker from any Chrome", async () => {
  const run: Run = {
    target: await startTarget(),
    relay: await startLabSignalRelay(),
    finished: false,
  };
  const stop = follow(run);
  try {
    run.server = await startManualServer({
      key: (jwk) => startBare(run, jwk),
      link: (sdp) => link(run, sdp),
      log: (text) => {
        // A reloaded page is back: only a close that stays closed ends the run.
        run.closedAt = undefined;
        say(`master: ${text}`);
      },
      finish: () => {
        run.finished = true;
      },
      closing: () => {
        run.closedAt = Date.now();
        say("master tab closed");
      },
    });
    say(`open ${run.server.origin}/ in your Chrome, then press Connect`);
    const ended = () => run.finished || (run.closedAt ?? Infinity) + AFTER_CLOSE_MS < Date.now();
    await until(() => Promise.resolve(ended()), Boolean, 29 * 60_000);
    summary(run);
  } finally {
    stop();
    await teardown(run);
  }
});
