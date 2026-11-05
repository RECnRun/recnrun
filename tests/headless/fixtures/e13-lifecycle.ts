import { setTimeout as delay } from "node:timers/promises";
import { POC_EXTENSION_ID, linkedPeers } from "../../browser/fixtures/downloads-profiles.ts";
import { within } from "../../browser/fixtures/trust.ts";
import { judged } from "../../experiments/fixtures/downloads-verdicts.ts";
import { presenceIn } from "../../experiments/fixtures/e4-launcher.ts";
import type { Sample } from "../../experiments/outcome.ts";
import { ensureOpen, masterLinked, modeProblems, timingOf } from "./e13-cells.ts";
import type { Lab, Launched, Mode, Worker } from "./e13-lab.ts";

/*
 * E13's lifecycle samples (POC PLAN.md P7.4): the master with no page open while workers run
 * headless, and one worker root opened headed, headless, headed with nothing reinstalled.
 */

const READ_MS = 90_000;
// Chrome writes a persistent cookie to disk within about 30 s (CHROMIUM.md group 17).
const FLUSH_MS = 35_000;
const DASHBOARD = `chrome-extension://${POC_EXTENSION_ID}/dashboard.html`;

/** Until the master no longer holds a verified link with `peer`; the milliseconds it took. */
async function droppedBy(lab: Lab, peer: string) {
  const started = Date.now();
  const gone = await within(
    async () => ((await linkedPeers(lab.master)).includes(peer) ? undefined : true),
    READ_MS,
  );
  return gone ? Date.now() - started : undefined;
}

/** Closes every page of the master but one blank page, which keeps its window; the dashboard is gone. */
async function closeMasterPages(lab: Lab) {
  const context = lab.master.context;
  const blank = await context.newPage();
  for (const page of context.pages()) if (page !== blank) await page.close();
  return blank;
}

/** The master's dashboard page, opened again for the cells that ask it for tabs. */
async function reopenDashboard(lab: Lab, blank: Awaited<ReturnType<typeof closeMasterPages>>) {
  lab.dashboard = await lab.master.context.newPage();
  await lab.dashboard.goto(DASHBOARD);
  await blank.close();
}

const seconds = (ms: number | undefined) => (ms === undefined ? null : Math.round(ms / 100) / 10);

/** t7.background: no dashboard and no page of the site on the master; a worker stops and returns. */
export async function backgroundSample(lab: Lab): Promise<Sample> {
  const [first, second] = lab.workers;
  if (!first || !second) throw new Error("t7.background needs two workers.");
  const problems: string[] = [];
  await ensureOpen(lab, "headless");
  const ids = lab.workers.map((worker) => worker.profileId);
  if (!(await masterLinked(lab, ids))) problems.push("the workers never linked");
  const blank = await closeMasterPages(lab);
  const pagesOpen = lab.master.context.pages().length;
  const stillLinked = (await linkedPeers(lab.master)).length;
  const oldPid = first.pid;
  await lab.stop(first);
  const dropMs = await droppedBy(lab, first.profileId);
  if (dropMs === undefined) problems.push(`the link to ${first.name} did not drop`);
  const secondUp = (await linkedPeers(lab.master)).includes(second.profileId);
  if (!secondUp) problems.push(`${second.name} lost its link with ${first.name}'s`);
  const again = await lab.open(first, "headless");
  if (again.code !== 0) problems.push(`relaunch exited ${again.code}: ${again.stderr.slice(-160)}`);
  problems.push(...again.problems, ...(await modeProblems(lab.probe, first, "headless")));
  const started = Date.now();
  const relinked = await masterLinked(lab, [first.profileId]);
  if (!relinked) problems.push(`the master never relinked ${first.name}`);
  if (first.pid === oldPid) problems.push("the relaunched worker kept the old process");
  await reopenDashboard(lab, blank);
  return judged(problems, {
    masterPages: pagesOpen,
    linkedWithNoPage: stillLinked,
    dropS: seconds(dropMs),
    relinkAfterAckS: seconds(Date.now() - started),
    relaunch: timingOf(again),
  });
}

interface Pass {
  mode: Mode;
  key: string;
  fingerprint: string;
  boot: string;
  cookieOnStart: string | null;
  linked: boolean;
  launched: Launched;
}

/** The request for the start page of this open, after `since`; what its Cookie header carried. */
const startCookie = (lab: Lab, marker: string, since: number) =>
  lab.site.seen.find((hit) => hit.at >= since && hit.path === `/start/${marker}`)?.cookie ?? null;

/** A headed open must load the marker page of the site; a headless one has no page but the bootstrap. */
async function pageProblems(lab: Lab, worker: Worker, mode: Mode, since: number) {
  if (mode !== "headed") return [];
  const marker = `/marker/${worker.marker}`;
  const loaded = await within(
    async () =>
      lab.site.seen.some((hit) => hit.at >= since && hit.path === marker) ? true : undefined,
    READ_MS,
  );
  return loaded ? [] : ["the headed worker never loaded the marker page"];
}

/** One mode of t8.alternate: open it, read identity and fingerprint from disk, wait for the cookie to flush. */
async function passIn(lab: Lab, mode: Mode, last: boolean) {
  const [worker] = lab.workers;
  if (!worker) throw new Error("t8.alternate needs a worker.");
  const since = Date.now();
  const launched = await lab.open(worker, mode);
  const presence = await presenceIn(worker.downloads, worker.profileId);
  const linked = (await masterLinked(lab, [worker.profileId])) !== undefined;
  const problems = [...launched.problems, ...(await modeProblems(lab.probe, worker, mode))];
  problems.push(...(await pageProblems(lab, worker, mode, since)));
  if (!last) await delay(FLUSH_MS);
  const pass: Pass = {
    mode,
    key: presence?.identity.key ?? "",
    fingerprint: presence?.fingerprint ?? "",
    boot: presence?.boot ?? "",
    cookieOnStart: startCookie(lab, worker.marker, since),
    linked,
    launched,
  };
  return { pass, problems };
}

/** t8.alternate: headed, headless, headed on one root; the identity, the certificate, and the cookie hold. */
export async function alternateSample(lab: Lab): Promise<Sample> {
  const [worker] = lab.workers;
  if (!worker) throw new Error("t8.alternate needs a worker.");
  const modes: Mode[] = ["headed", "headless", "headed"];
  const passes: Pass[] = [];
  const problems: string[] = [];
  for (const [index, mode] of modes.entries()) {
    if (worker.pid > 0) await lab.stop(worker);
    const result = await passIn(lab, mode, index === modes.length - 1);
    passes.push(result.pass);
    problems.push(...result.problems.map((problem) => `${mode}: ${problem}`));
  }
  problems.push(...stableProblems(worker.marker, passes));
  return judged(problems, {
    passes: passes.map((pass) => ({
      linked: pass.linked,
      cookieOnStart: pass.cookieOnStart,
      fingerprint: pass.fingerprint.slice(0, 11),
      ...timingOf(pass.launched),
    })),
  });
}

/** What must not change between the passes: key, fingerprint, the cookie from the second open on, the link. */
function stableProblems(marker: string, passes: Pass[]): string[] {
  const problems: string[] = [];
  const [first] = passes;
  for (const pass of passes) {
    if (!pass.linked) problems.push(`${pass.mode}: no verified link with the master (file access)`);
    if (pass.key !== first?.key) problems.push(`${pass.mode}: the identity key changed`);
    if (pass.fingerprint !== first?.fingerprint)
      problems.push(`${pass.mode}: the fingerprint changed`);
  }
  // Only a headed open carries a page of the site, so the cookie of the first headed pass must reach the last.
  for (const pass of passes.slice(1).filter((each) => each.mode === "headed")) {
    if (pass.cookieOnStart !== `e13=${marker}`)
      problems.push(`${pass.mode}: the start request carried cookie "${pass.cookieOnStart}"`);
  }
  if (new Set(passes.map((pass) => pass.boot)).size !== passes.length)
    problems.push("two opens reported the same boot");
  return problems;
}
