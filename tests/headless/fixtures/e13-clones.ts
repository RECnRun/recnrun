import { readFile } from "node:fs/promises";
import type { TestInfo } from "@playwright/test";
import { isChildProcess } from "../../browser/fixtures/clone-attach.ts";
import { labClones } from "../../browser/fixtures/clone-rig.ts";
import type { LabClones } from "../../browser/fixtures/clone-rig.ts";
import { windowOwners } from "../../browser/fixtures/x-display.ts";
import { chromesOf } from "../../browser/fixtures/launcher-rig.ts";
import { ackFile, bindMaster } from "../../experiments/fixtures/clone-round.ts";
import { createClone, openClone } from "../../experiments/fixtures/clones.ts";
import { judged } from "../../experiments/fixtures/downloads-verdicts.ts";
import { presenceIn } from "../../experiments/fixtures/e4-launcher.ts";
import type { Sample } from "../../experiments/outcome.ts";
import { PAGE_ENV, PAGE_FLAG, dockerProbe } from "./e13-lab.ts";
import type { Mode, Worker } from "./e13-lab.ts";
import { masterLinked, modeProblems } from "./e13-cells.ts";
import { commandsSample, markerSample, tabsSample } from "./e13-remote.ts";
import { startSite } from "./e13-site.ts";
import type { Site } from "./e13-site.ts";

/*
 * E13's clone samples (POC PLAN.md P7.4 T9): clones of the frozen base opened headless by
 * clone-open.sh, provisioned and linked to the master, with no CDP client on any clone. The master
 * is the lab's headed Playwright Chrome. The binding the local channel writes in the product is
 * written to the master's storage by the harness, as in P5.5.
 */

export interface CloneLab {
  site: Site;
  host: LabClones;
  dir: string;
  clones: Worker[];
  dispose(): Promise<void>;
}

export async function cloneLab(testInfo: TestInfo): Promise<CloneLab> {
  const site = await startSite();
  try {
    const host = await labClones(testInfo, site.origin, [PAGE_FLAG]);
    const dir = await host.clonesDir();
    const dispose = async () => {
      await host.dispose();
      await site.close();
    };
    return { site, host, dir, clones: [], dispose };
  } catch (error) {
    await site.close();
    throw error;
  }
}

/** What the master asks of the clones: its dashboard and the site they load. */
function remoteOf(lab: CloneLab) {
  const dashboard = lab.host.master.view?.dashboard;
  if (!dashboard) throw new Error("The lab master has no dashboard.");
  return { dashboard, site: lab.site };
}

/** The ack's createdAt, read from disk, minus `since`: how long until the extension answered. */
async function ackSeconds(downloads: string, id: string, token: string, since: number) {
  const ack = JSON.parse(await readFile(ackFile(downloads, id, token), "utf8")) as {
    createdAt?: number;
  };
  return typeof ack.createdAt === "number" ? Math.round((ack.createdAt - since) / 100) / 10 : null;
}

/** Makes clone `name` and opens it with `mode`, carrying the test page as a startup page. */
async function openNew(lab: CloneLab, name: string, mode: Mode) {
  const created = await createClone(lab.host, lab.dir, name);
  const marker = created.instanceId.replaceAll("-", "");
  const started = Date.now();
  const env = mode === "headed" ? { [PAGE_ENV]: lab.site.startUrl(marker) } : {};
  const opened = await openClone(lab.host, lab.dir, name, { mode, env });
  const { root: downloads = "", token = "" } = opened.fields;
  lab.host.watch(created.root);
  if (downloads !== "") lab.host.track(downloads);
  const clone: Worker = {
    name,
    profileId: created.instanceId,
    marker,
    root: created.root,
    downloads,
    pid: opened.pid,
    token,
  };
  lab.clones.push(clone);
  const ack =
    opened.code === 0 ? await ackSeconds(downloads, clone.profileId, token, started) : null;
  return { clone, opened, ackS: ack };
}

/** Ends the previous sample's clones and gives this one a fresh clones directory, so names repeat. */
async function freshRound(lab: CloneLab) {
  if (lab.clones.length === 0) return;
  for (const clone of lab.clones) await lab.host.quit(clone.root);
  lab.clones.length = 0;
  lab.dir = await lab.host.clonesDir();
}

/** t9.clones: each clone is headless, provisioned, linked to the master, with an identity of its own. */
export async function clonesSample(lab: CloneLab, names: string[]): Promise<Sample> {
  await freshRound(lab);
  const problems: string[] = [];
  const opens: Record<string, unknown>[] = [];
  for (const name of names) {
    const { clone, opened, ackS } = await openNew(lab, name, "headless");
    if (opened.code !== 0)
      problems.push(`${name}: open-clone exited ${opened.code} ${opened.stderr.slice(-200)}`);
    problems.push(...(await modeProblems(dockerProbe, clone, "headless")));
    opens.push({ name, exit: opened.code, totalS: Math.round(opened.ms / 100) / 10, ackS });
  }
  const master = lab.host.master.profile;
  if (!master) throw new Error("The lab master is not attached.");
  const linked = await masterLinked(
    { master },
    lab.clones.map((clone) => clone.profileId),
  );
  if (!linked) problems.push("the master holds no verified link with every clone");
  const keys = await Promise.all(
    lab.clones.map(
      async (clone) => (await presenceIn(clone.downloads, clone.profileId))?.identity.key,
    ),
  );
  if (keys.some((key) => key === undefined) || new Set(keys).size !== lab.clones.length)
    problems.push("the clones do not all have a presence with a distinct identity");
  await bindMaster(lab.host, lab.clones);
  return judged(problems, { clones: lab.clones.length, opens, identities: new Set(keys).size });
}

/** The samples of the cells that run on the clones of every round, in round order. */
export interface RoundOps {
  tabs: Sample[];
  marker: Sample[];
  commands: Sample[];
}

/** One round: `clonesSample`, then the master's ops on that round's clones, kept in `ops`. */
export async function roundSample(lab: CloneLab, names: string[], ops: RoundOps): Promise<Sample> {
  const sample = await clonesSample(lab, names);
  const remote = remoteOf(lab);
  ops.tabs.push(await tabsSample(remote, lab.clones));
  ops.marker.push(await markerSample(remote, lab.clones));
  ops.commands.push(await commandsSample(remote, lab.clones));
  return sample;
}

/** Hands out the kept samples one by one, to the recorder that asks for one per round. */
export const replayed = (samples: Sample[]) => async (): Promise<Sample> => {
  const next = samples.shift();
  if (!next) throw new Error("A cell asked for more rounds than ran.");
  return next;
};

/** The pids of the processes of a root that are not children (a renderer, a utility) of its main one. */
const mainProcesses = async (root: string) =>
  (
    await Promise.all(
      (await chromesOf(root)).map(async (pid) => ({
        pid,
        line: await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => ""),
      })),
    )
  ).filter(({ line }) => !isChildProcess(line));

/** open.sh's exit when the root already runs the other mode. */
const OTHER_MODE_REFUSED = 65;

/** The refusal's exit and the one running process it must leave untouched. */
function refusalProblems(code: number, before: number[], after: Set<number>) {
  const problems: string[] = [];
  if (code !== OTHER_MODE_REFUSED) problems.push(`exit ${code}, not the other-mode refusal`);
  if (before.length !== 1) problems.push(`${before.length} main processes before the request`);
  if (!before.every((pid) => after.has(pid))) problems.push("the running process was replaced");
  return problems;
}

/** What a running clone looks like after the launcher was asked to open it in the other mode. */
async function afterRequest(lab: CloneLab, clone: Worker, asked: Mode, running: Mode) {
  const before = (await mainProcesses(clone.root)).map(({ pid }) => pid);
  const env = asked === "headed" ? { [PAGE_ENV]: lab.site.startUrl(clone.marker) } : {};
  const result = await openClone(lab.host, lab.dir, clone.name, { mode: asked, env });
  const after = await mainProcesses(clone.root);
  const headless = after.some(({ line }) => line.includes("--headless"));
  const pids = new Set(after.map(({ pid }) => pid));
  const windows = (await windowOwners("chrome")).filter((pid) => pids.has(pid)).length;
  const problems = refusalProblems(result.code, before, pids);
  if (after.length !== 1) problems.push(`${after.length} main processes after the request`);
  if (headless !== (running === "headless"))
    problems.push(`the running mode changed from ${running}`);
  if (running === "headless" && windows > 0) problems.push("a visible window appeared");
  const outcome = result.code === 0 ? "forwarded" : "refused";
  return {
    problems,
    observation: {
      running,
      asked,
      outcome,
      exit: result.code,
      stderr: result.stderr.slice(-200),
      mainBefore: before.length,
      mainAfter: after.length,
      survivorSame: before.every((pid) => pids.has(pid)),
      windows,
      // Which processes counted as main, when more than one did.
      ...(after.length === 1
        ? {}
        : { mainLines: after.map(({ line }) => line.replaceAll("\0", " ").slice(0, 160)) }),
    },
  };
}

/** t9.exclusive: one clone is never visible and headless at once, whichever mode it started in. */
export async function exclusiveSample(lab: CloneLab): Promise<Sample> {
  const [headlessOne, other] = lab.clones;
  if (!headlessOne || !other) throw new Error("t9.exclusive needs two clones.");
  const first = await afterRequest(lab, headlessOne, "headed", "headless");
  await lab.host.quit(other.root);
  const reopened = await openClone(lab.host, lab.dir, other.name, {
    mode: "headed",
    env: { [PAGE_ENV]: lab.site.startUrl(other.marker) },
  });
  const second =
    reopened.code === 0
      ? await afterRequest(lab, other, "headless", "headed")
      : { problems: [`B did not reopen headed: ${reopened.stderr.slice(-200)}`], observation: {} };
  return judged([...first.problems, ...second.problems], {
    headlessThenHeaded: first.observation,
    headedThenHeadless: second.observation,
  });
}
