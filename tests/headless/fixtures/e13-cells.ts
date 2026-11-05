import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveChromePath } from "../../browser/fixtures/chrome.ts";
import { linkedPeers } from "../../browser/fixtures/downloads-profiles.ts";
import { askPeers } from "../../browser/fixtures/master-restart.ts";
import { within } from "../../browser/fixtures/trust.ts";
import { windowOwners } from "../../browser/fixtures/x-display.ts";
import { chromesOf } from "../../browser/fixtures/launcher-rig.ts";
import { judged } from "../../experiments/fixtures/downloads-verdicts.ts";
import { recordHypothesis } from "../../experiments/outcome.ts";
import type { Cell, Sample } from "../../experiments/outcome.ts";
import { commandLinesOf } from "./e13-lab.ts";
import type { Launched, Lab, Mode, Worker } from "./e13-lab.ts";

/*
 * The samples of E13 (POC PLAN.md P7.4) over the V1 workers: each reads what the master sees over
 * its verified link, and what /proc, the X server, and the root's files say about a worker whose
 * Chrome no CDP client ever reached.
 */

export const EXPERIMENT = "E13";

export const HYPOTHESES = [
  "E13.t6.workers",
  "E13.t6.commands",
  "E13.t7.background",
  "E13.t8.alternate",
  "E13.ops.tabs",
  "E13.ops.navigation",
  "E13.ops.marker",
  "E13.focus",
  "E13.pip",
  "E13.t9.clones",
  "E13.t9.commands",
  "E13.t9.exclusive",
  "E13.diag.bootstrapTab",
] as const;

const READ_MS = 90_000;

/** `google-chrome --version`, the binary open.sh starts. */
export async function chromeVersion(): Promise<string> {
  return (await promisify(execFile)(resolveChromePath(), ["--version"])).stdout.trim();
}

/** A verdict cell of E13: the master is attached (a diagnostic), no worker ever is. */
export async function cellOf(hypothesis: string, topology: string): Promise<Cell> {
  return {
    experiment: EXPERIMENT,
    hypothesis: `E13.${hypothesis}`,
    chrome: await chromeVersion(),
    environment: "lab",
    install: "loadUnpacked",
    label: "diagnostic",
    externalClient: true,
    variant: "poc-d0",
    topology: `${topology}; the master is headed on Xvfb and stands in for the personal Default, no CDP client is on any worker`,
    debugger: "none",
  };
}

export const record = async (
  hypothesis: string,
  topology: string,
  take: () => Promise<Sample>,
  full = 3,
) => recordHypothesis(await cellOf(hypothesis, topology), take, { full });

/** What the lab learned of one open, for an observation. */
export const timingOf = (launched: Launched) => ({
  mode: launched.mode,
  exit: launched.code,
  totalS: Math.round(launched.totalMs / 100) / 10,
  presenceS: launched.presenceMs === undefined ? null : Math.round(launched.presenceMs / 100) / 10,
  ackS: launched.ackMs === undefined ? null : Math.round(launched.ackMs / 100) / 10,
});

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** What a worker of `mode` must look like from outside: its flags, its root, its windows. */
export async function modeProblems(worker: Worker, mode: Mode): Promise<string[]> {
  const lines = await commandLinesOf(worker.root);
  const problems: string[] = [];
  if (lines.length === 0) problems.push(`${worker.name}: no Chrome names its root`);
  const headless = lines.some((line) => /--headless/.test(line));
  if (mode === "headless" && !headless) problems.push(`${worker.name}: no --headless flag`);
  if (mode === "headed" && headless) problems.push(`${worker.name}: --headless in a headed open`);
  if (lines.some((line) => line.includes("remote-debugging")))
    problems.push(`${worker.name}: a debugging flag is on its command line`);
  if (await exists(join(worker.root, "DevToolsActivePort")))
    problems.push(`${worker.name}: a DevToolsActivePort file exists, a client could attach`);
  const pids = new Set(await chromesOf(worker.root));
  const owned = (await windowOwners("chrome")).filter((pid) => pids.has(pid));
  if (mode === "headless" && owned.length > 0)
    problems.push(`${worker.name}: ${owned.length} X windows belong to its processes`);
  return problems;
}

/** The workers not running are opened in `mode`, all at once; the timing of each open comes back. */
export async function ensureOpen(lab: Lab, mode: Mode, only = lab.workers): Promise<Launched[]> {
  const opened = only.filter((worker) => worker.pid === 0);
  return Promise.all(opened.map((worker) => lab.open(worker, mode)));
}

/** Waits until the master holds a verified link with every `peers` profile. */
export async function masterLinked(lab: Pick<Lab, "master">, peers: string[], ms = READ_MS) {
  return within(async () => {
    const linked = await linkedPeers(lab.master);
    return peers.every((peer) => linked.includes(peer)) ? linked : undefined;
  }, ms);
}

export interface Tab {
  id: number;
  title?: string;
  url?: string;
}

/** The tabs `peer` last reported to the master's dashboard `page`; empty when the request fails. */
async function tabsOf(page: Lab["dashboard"], peer: string): Promise<Tab[]> {
  const reply = await askPeers(page, { type: "tabs", peer });
  return reply.ok ? ((reply.result as { tabs?: Tab[] }).tabs ?? []) : [];
}

/** True when `tab` is the bootstrap page of the last open of `worker`: its fragment is that open's token. */
const ownsTab = (tab: Tab, worker: Pick<Worker, "token">) =>
  worker.token !== "" && (tab.url ?? "").includes(`bootstrap.html#token=${worker.token}`);

/** The worker's own tab, as the master's `tabs` request lists it; the only tab a headless worker has. */
export async function ownTab(lab: Lab, worker: Worker) {
  return within(async () => {
    const tabs = await tabsOf(lab.dashboard, worker.profileId);
    return tabs.find((tab) => ownsTab(tab, worker));
  }, READ_MS);
}

const openProblems = (launched: Launched[], workers: Worker[]) =>
  launched.flatMap((open, index) =>
    open.code === 0 && open.problems.length === 0
      ? []
      : [
          `${workers[index]?.name}: open exited ${open.code} ${open.stderr.slice(-160)} ${open.problems.join(" ")}`,
        ],
  );

/** t6.workers: each worker is its own headless process on a root of its own, linked to the master. */
export async function workersSample(lab: Lab): Promise<Sample> {
  for (const worker of lab.workers) if (worker.pid > 0) await lab.stop(worker);
  const launched = await ensureOpen(lab, "headless");
  const problems = openProblems(launched, lab.workers);
  for (const worker of lab.workers) problems.push(...(await modeProblems(worker, "headless")));
  const pids = new Set(lab.workers.map((worker) => worker.pid));
  if (pids.size !== lab.workers.length) problems.push("two workers share one main process");
  const linked = await masterLinked(
    lab,
    lab.workers.map((worker) => worker.profileId),
  );
  if (!linked) problems.push("the master holds no verified link with every worker");
  return judged(problems, {
    workers: lab.workers.length,
    opens: launched.map(timingOf),
    linked: linked?.length ?? 0,
  });
}

/** t6.commands: the master asks a worker for its tabs, then activates one; refused when the worker is not bound to it. */
export async function commandsSample(lab: Lab): Promise<Sample> {
  const problems: string[] = [];
  const replies: unknown[] = [];
  for (const worker of lab.workers) {
    const asked = await askPeers(lab.dashboard, { type: "tabs", peer: worker.profileId });
    const listed = asked.ok ? (asked.result as { tabs?: Tab[] }).tabs : undefined;
    replies.push({
      name: worker.name,
      tabs: asked.ok ? listed?.map((tab) => tab.url) : asked.error,
    });
    if (!asked.ok) {
      problems.push(`${worker.name}: tabs refused: ${asked.error}`);
      continue;
    }
    const tab = await ownTab(lab, worker);
    if (!tab) {
      problems.push(`${worker.name}: the master lists no tab of the worker to activate`);
      continue;
    }
    const reply = await askPeers(lab.dashboard, {
      type: "activate",
      peer: worker.profileId,
      tabId: tab.id,
    });
    if (!reply.ok) problems.push(`${worker.name}: ${reply.error}`);
  }
  return judged(problems, { replies });
}
