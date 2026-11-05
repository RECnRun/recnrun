import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import type { DownloadsProfile } from "../../browser/fixtures/downloads-profiles.ts";
import type { Profile } from "../../e2e/fixtures/profiles.ts";
import { recordHypothesis } from "../outcome.ts";
import type { Cell, Sample } from "../outcome.ts";
import { judged } from "./downloads-verdicts.ts";
import type { VerdictTarget } from "./downloads-verdicts.ts";

/*
 * The clone matrix of P5.5 (POC PLAN.md CL05 and CL08 to CL12), shared by the lab spec and its host
 * twin: the cells, the launcher scripts that make and open clones, and what a round holds. Where the
 * master is attached (the lab) a cell reads its side; where it is not (the owner's personal Default
 * on the host) the cell reads the clones' sides.
 */

const SCRIPTS = fileURLToPath(new URL("../../../scripts/poc-cross-profile/", import.meta.url));
export const NAMESPACE = "lab";
// Apart from cross-root-link.spec.ts, which records its own P5.5 cells in the same run.
export const CLONE_EXPERIMENT = "P5.5.clones";
const OPEN_TIMEOUT_S = 90;
const SCRIPT_MS = 300_000;

/** Each cell and its topology. */
export const CLONE_CELLS = {
  "P5.5.CL05.threeRoots": "master and clones A and B, each running on a root of its own",
  "P5.5.CL08.isolation": "A and B write cookie, localStorage, IndexedDB, and extension storage",
  "P5.5.CL09.permissions": "the permissions each clone holds and the Downloads it exercises",
  "P5.5.CL10.commands": "master commands on A and B; worker commands on a worker or master",
  "P5.5.CL11.reopenB": "B stopped and reopened through the launcher path",
  "P5.5.CL12.cLater": "C made from the original base after A and B worked",
} as const;
export type CloneHypothesis = keyof typeof CLONE_CELLS;

/** The master of a round: attached in the lab, only its presence and record block on the host. */
interface MasterSide {
  profileId: string;
  downloads: string;
  profile?: DownloadsProfile;
  /** The attached master's tab and dashboard. */
  view?: Profile;
}

/** What a rig gives a round, in the lab's Docker or on the host. */
export interface CloneHost {
  env: NodeJS.ProcessEnv;
  bases: string;
  base: string;
  record: string;
  baseURL: string;
  master: MasterSide;
  /** A fresh clones directory for one round. */
  clonesDir(): Promise<string>;
  /** The command lines of the processes whose arguments name `root` as the user data directory. */
  commandLines(root: string): Promise<string[]>;
  /** Attaches Playwright to the Chrome running on a clone root. */
  attach(root: string, name: string, instanceId: string): Promise<DownloadsProfile>;
  /** Detaches, ends the Chrome of `root` with SIGTERM, and waits until nothing names it. */
  stop(profile: DownloadsProfile): Promise<void>;
  /** Tells the launcher's catalog loop about a Downloads root the record now names. */
  track(downloads: string): void;
  /** Saves a screenshot of the page under the run's artifacts. */
  shoot(page: Page, name: string): Promise<void>;
}

/** One script run: its exit status, the `key=value` lines of stdout, and how long it took. */
export interface Scripted {
  code: number;
  fields: Record<string, string>;
  stderr: string;
  ms: number;
  pid: number;
}

function parsed(stdout: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1);
  }
  return fields;
}

/** `sh <script> <command> <args>`; a non-zero exit is a result, not a throw. */
export function runScript(
  script: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<Scripted> {
  const started = Date.now();
  const options = { env: { ...env, RECNRUN_OPEN_TIMEOUT_S: String(OPEN_TIMEOUT_S) } };
  return new Promise((resolve) => {
    const done = (error: { code?: unknown } | null, stdout: string, stderr: string) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      const pid = Number(/pid=(\d+)/.exec(stderr)?.[1] ?? 0);
      resolve({ code, fields: parsed(stdout), stderr, ms: Date.now() - started, pid });
    };
    const run = [join(SCRIPTS, script), ...args];
    execFile("sh", run, { ...options, encoding: "utf8", timeout: SCRIPT_MS }, done);
  });
}

/** A clone as `clone.sh create-clone` printed it. */
export interface Created {
  name: string;
  root: string;
  instanceId: string;
  copyS: number;
  physicalKiB: number;
  logicalBytes: number;
  wallMs: number;
}

export async function createClone(host: CloneHost, clones: string, name: string): Promise<Created> {
  const args = ["create-clone", host.bases, host.base, clones, name, NAMESPACE];
  const run = await runScript("clone.sh", args, host.env);
  if (run.code !== 0) throw new Error(`create-clone ${name} exited ${run.code}: ${run.stderr}`);
  const { clone = "", instanceId = "" } = run.fields;
  const count = (key: string) => Number(run.fields[key] ?? Number.NaN);
  const [copyS, physicalKiB, logicalBytes] = ["copyS", "physicalKiB", "logicalBytes"].map(count);
  return {
    name,
    root: clone,
    instanceId,
    copyS: copyS ?? Number.NaN,
    physicalKiB: physicalKiB ?? Number.NaN,
    logicalBytes: logicalBytes ?? Number.NaN,
    wallMs: run.ms,
  };
}

/** `clone-open.sh open-clone`, which also reopens a clone the record already registers. */
export const openClone = (
  host: CloneHost,
  clones: string,
  name: string,
  { mode, env = {} }: { mode?: "headed" | "headless"; env?: NodeJS.ProcessEnv } = {},
) =>
  runScript(
    "clone-open.sh",
    ["open-clone", clones, name, host.record, NAMESPACE, ...(mode ? [mode] : [])],
    { ...host.env, ...env },
  );

/** The file at `path` as JSON. */
export const readJson = async (path: string) =>
  JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

/** The namespace folder of a Downloads root: presences, acks, signals. */
export const folderOf = (downloads: string) => join(downloads, "RECnRun", "poc", NAMESPACE);

/** The records of the matrix: the sample of a cell, or a sample that says why none could be taken. */
export type RoundSamples = Record<CloneHypothesis, Sample>;

/** Samples from problems; `measurements` rides in the observation of every cell. */
export const sampleOf = (problems: string[], observation: Record<string, unknown>): Sample =>
  judged(problems, observation);

/** Records one cell of P5.5 through outcome.ts: `full` samples are the rounds (one in smoke mode). */
export async function recordClone(
  hypothesis: CloneHypothesis,
  target: VerdictTarget,
  take: () => Promise<Sample>,
) {
  const cell: Cell = {
    experiment: CLONE_EXPERIMENT,
    hypothesis,
    chrome: await target.chrome(),
    environment: target.environment,
    install: "loadUnpacked",
    label: "diagnostic",
    externalClient: true,
    variant: "poc-d0",
    topology: CLONE_CELLS[hypothesis],
    debugger: "none",
  };
  const directory = target.directory?.();
  return recordHypothesis(cell, take, directory === undefined ? {} : { directory });
}
