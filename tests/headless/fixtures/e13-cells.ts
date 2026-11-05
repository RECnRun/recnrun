import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveChromePath } from "../../browser/fixtures/chrome.ts";
import { linkedPeers } from "../../browser/fixtures/downloads-profiles.ts";
import { within } from "../../browser/fixtures/trust.ts";
import { judged } from "../../experiments/fixtures/downloads-verdicts.ts";
import { recordHypothesis, recordUnavailable } from "../../experiments/outcome.ts";
import type { Cell, Sample } from "../../experiments/outcome.ts";
import type { Launched, Lab, Mode, Probe, Worker } from "./e13-lab.ts";

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
async function chromeVersion(): Promise<string> {
  return (await promisify(execFile)(resolveChromePath(), ["--version"])).stdout.trim();
}

/** Where a run measures: the Docker lab, or the Mac with its own evidence folder. */
export interface Where {
  environment: "lab" | "host";
  chrome(): Promise<string>;
  /** How the master is described in a topology. */
  master: string;
  directory?: string;
}

export const LAB: Where = {
  environment: "lab",
  chrome: chromeVersion,
  master: "the master is headed on Xvfb and stands in for the personal Default",
};

/** A verdict cell of E13: the master is attached (a diagnostic), no worker ever is. */
export async function cellOf(hypothesis: string, topology: string, where = LAB): Promise<Cell> {
  return {
    experiment: EXPERIMENT,
    hypothesis: `E13.${hypothesis}`,
    chrome: await where.chrome(),
    environment: where.environment,
    install: "loadUnpacked",
    label: "diagnostic",
    externalClient: true,
    variant: "poc-d0",
    topology: `${topology}; ${where.master}, no CDP client is on any worker`,
    debugger: "none",
  };
}

/** Records cells of E13 in `where`; `full` samples, one in smoke mode. */
export const recorderOf = (where = LAB) => ({
  record: async (hypothesis: string, topology: string, take: () => Promise<Sample>, full = 3) =>
    recordHypothesis(await cellOf(hypothesis, topology, where), take, {
      full,
      ...(where.directory === undefined ? {} : { directory: where.directory }),
    }),
  unavailable: async (hypothesis: string, topology: string, reason: string) =>
    recordUnavailable(await cellOf(hypothesis, topology, where), reason, where.directory),
});

export const { record } = recorderOf();

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

/** The flags of a worker's processes: --headless exactly when asked, and never a debugging flag. */
function flagProblems(name: string, lines: string[], mode: Mode): string[] {
  const problems: string[] = [];
  if (lines.length === 0) problems.push(`${name}: no Chrome names its root`);
  const headless = lines.some((line) => /--headless/.test(line));
  if (mode === "headless" && !headless) problems.push(`${name}: no --headless flag`);
  if (mode === "headed" && headless) problems.push(`${name}: --headless in a headed open`);
  if (lines.some((line) => line.includes("remote-debugging")))
    problems.push(`${name}: a debugging flag is on its command line`);
  return problems;
}

/** What a worker of `mode` must look like from outside: its flags, its root, its windows. */
export async function modeProblems(probe: Probe, worker: Worker, mode: Mode): Promise<string[]> {
  const problems = flagProblems(worker.name, await probe.commandLines(worker.root), mode);
  if (await exists(join(worker.root, "DevToolsActivePort")))
    problems.push(`${worker.name}: a DevToolsActivePort file exists, a client could attach`);
  const owned = (await probe.windows?.(worker.root)) ?? 0;
  if (mode === "headless" && owned > 0)
    problems.push(`${worker.name}: ${owned} X windows belong to its processes`);
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
  for (const worker of lab.workers)
    problems.push(...(await modeProblems(lab.probe, worker, "headless")));
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
