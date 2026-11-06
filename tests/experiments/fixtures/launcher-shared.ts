import { readFile } from "node:fs/promises";
import {
  ackProblems,
  openProblems,
  quit,
  runOpen,
  settledProblems,
  until,
} from "./launcher-open.ts";
import type { Opened, Rig, Scene } from "./launcher-open.ts";
import { recordHypothesis } from "../outcome.ts";
import type { Cell } from "../outcome.ts";
import type { Sample, VerdictTarget } from "./downloads-verdicts.ts";

/*
 * P4.3 on a shared root (POC PLAN.md P4.3, source question 14.4): two profiles of one user data dir,
 * Default open, and open.sh asked for the second. Chrome's process singleton hands the command line to
 * the running browser (CHROMIUM.md group 2), so the pid open.sh prints is a forwarder that exits at
 * once and the profile lives in the process of the first. The ack, not the pid, is the proof.
 */

const GONE_MS = 10_000;

/** Two registered profiles of one root: the first is the rig's scene. */
export interface SharedPair extends Rig {
  second: Scene;
}

/** True while the process exists and is no zombie (a reparented forwarder can linger as one in a container). */
async function running(pid: number): Promise<boolean> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
  const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
  return state !== "" && state !== "Z";
}

/** The problems of one open of `scene`: the printed result and the ack on disk. */
async function openChecks(scene: Scene, opened: Opened, previous?: Opened): Promise<string[]> {
  const problems = openProblems(scene.downloads, opened, previous);
  return opened.code === 0 ? [...problems, ...(await ackProblems(scene, opened))] : problems;
}

/** The forwarder is gone, the main process of the root is not, and they are two processes. */
async function forwardingProblems(main: number, forwarder: number): Promise<string[]> {
  const problems: string[] = [];
  if (forwarder === main) problems.push(`open.sh printed the main pid ${main} again`);
  const gone = async () => ((await running(forwarder)) ? undefined : true);
  await until(gone, `forwarder ${forwarder} exit`, GONE_MS).catch(() =>
    problems.push(`the printed pid ${forwarder} still runs`),
  );
  if (!(await running(main))) problems.push(`the root's Chrome ${main} is gone`);
  return problems;
}

/** Default, then Profile 1 while it runs, and with `again` a third open of Profile 1. */
async function measure(rig: SharedPair, again: boolean, pids: number[]): Promise<Sample> {
  const first = await runOpen(rig);
  pids.push(first.pid);
  const problems = await openChecks(rig.scene, first);
  const second = await runOpen({ scene: rig.second, env: rig.env });
  pids.push(second.pid);
  problems.push(...(await openChecks(rig.second, second)));
  problems.push(...(await forwardingProblems(first.pid, second.pid)));
  const observation: Record<string, unknown> = {
    mainPid: first.pid,
    forwarderPid: second.pid,
    secondMs: second.ms,
    secondBoot: second.boot === second.token ? "its fresh token" : "another boot",
  };
  if (again) {
    const third = await runOpen({ scene: rig.second, env: rig.env });
    pids.push(third.pid);
    observation.thirdBootKept = third.boot === second.boot;
    problems.push(...(await openChecks(rig.second, third, second)));
  }
  for (const scene of [rig.scene, rig.second])
    problems.push(...(await settledProblems(scene.downloads)));
  const error = problems.length > 0 ? { error: problems.join("; ") } : {};
  return { ok: problems.length === 0, ...error, observation };
}

/** One sample on a rig of two profiles; only the Chrome open.sh spawned is signalled, nothing is left behind. */
export async function sharedSample(
  setup: () => Promise<SharedPair>,
  again: boolean,
): Promise<Sample> {
  const rig = await setup();
  const pids: number[] = [];
  try {
    const sample = await measure(rig, again, pids).catch(async (error: unknown) => {
      await rig.keep?.().catch(() => undefined);
      throw error;
    });
    await quit(rig, pids);
    if (!sample.ok) await rig.keep?.().catch(() => undefined);
    return sample;
  } finally {
    try {
      await quit(rig, pids);
    } finally {
      await rig.dispose();
    }
  }
}

/** The two cells of P4.3 on a shared root, with their topologies. */
export const SHARED_CELLS = {
  "P4.3.open.sharedRoot": "two profiles of one root: Default running, open.sh for Profile 1",
  "P4.3.open.sharedRunning": "the same, then a second open.sh for Profile 1 while it runs",
} as const;
export type SharedHypothesis = keyof typeof SHARED_CELLS;

/** Records one verdict; the experiment id differs from P4.3's so the single-root spec keeps its exact set. */
export async function recordShared(
  hypothesis: SharedHypothesis,
  target: VerdictTarget,
  take: () => Promise<Sample>,
) {
  const cell: Cell = {
    experiment: "P4.3.shared",
    hypothesis,
    chrome: await target.chrome(),
    environment: target.environment,
    install: "loadUnpacked",
    label: "diagnostic",
    externalClient: true,
    variant: "poc-d0",
    topology: SHARED_CELLS[hypothesis],
    debugger: "none",
  };
  const directory = target.directory?.();
  return recordHypothesis(cell, take, directory === undefined ? {} : { directory });
}
