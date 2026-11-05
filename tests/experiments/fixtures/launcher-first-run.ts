import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { recordHypothesis } from "../outcome.ts";
import type { Cell } from "../outcome.ts";
import type { Sample, VerdictTarget } from "./downloads-verdicts.ts";
import type { Rig, Scene } from "./launcher-open.ts";

/*
 * The shared-root sample of P4.6 (POC PLAN.md): first-run.sh on the usual layout, one user data
 * root whose profiles all download to ~/Downloads and an empty record. Each profile is bound by its
 * token ack, registered with the id the extension acked, and opened; status then lists both.
 */

const SCRIPTS = new URL("../../../scripts/poc-cross-profile/", import.meta.url);
const FIRST_RUN = fileURLToPath(new URL("first-run.sh", SCRIPTS));
const LAUNCHER = fileURLToPath(new URL("recnrun-launcher.sh", SCRIPTS));
const NAMESPACE = "lab";
const QUIT_MS = 20_000;
const POLL_MS = 100;

/** A root of two profiles that share one Downloads folder; the first is the rig's scene. */
export interface FirstRunPair extends Rig {
  second: Scene;
}

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/** One script run; a non-zero exit is a result, not a throw. */
function run(rig: Rig, script: string, args: string[]): Promise<Ran> {
  const env = { ...rig.env, RECNRUN_OPEN_TIMEOUT_S: "60", RECNRUN_LIFECYCLE_STOP_S: "20" };
  return new Promise((resolve) => {
    execFile("sh", [script, ...args], { env, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error ? ((error as { code?: number }).code ?? 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

/** The blocks of the record as `key=value` maps, in file order. */
async function blocksOf(record: string): Promise<Record<string, string>[]> {
  const text = await readFile(record, "utf8").catch(() => "");
  return text
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) =>
      Object.fromEntries(
        block
          .split("\n")
          .filter((line) => line.includes("="))
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      ),
    );
}

/** What first-run.sh and status must show for both profiles; every failed expectation is a problem. */
async function measure(rig: FirstRunPair): Promise<Sample> {
  const { record, downloads } = rig.scene;
  const state = join(dirname(record), "state");
  const problems: string[] = [];
  const want = (ok: boolean, text: string) => ok || problems.push(text);
  const ids = [rig.scene, rig.second];
  const first = await run(rig, FIRST_RUN, [state, record, NAMESPACE]);
  want(first.code === 0, `first-run exited ${first.code}: ${first.stderr.slice(-400)}`);
  const lines = first.stdout.split("\n");
  ids.forEach((scene, at) =>
    want(lines[at] === `${scene.profileId} open`, `line ${at}: ${lines[at]}`),
  );
  const blocks = await blocksOf(record);
  want(blocks.length === 2, `the record held ${blocks.length} blocks`);
  ids.forEach((scene, at) => {
    const block = blocks[at] ?? {};
    const got = [block.profileDirectory, block.profileId, block.downloadsRoot, block.namespace];
    const expected = [scene.profileDirectory, scene.profileId, downloads, NAMESPACE];
    want(got.join("|") === expected.join("|"), `block ${at}: ${got.join("|")}`);
  });
  const status = (await run(rig, LAUNCHER, ["status", state])).stdout.split("\n");
  ids.forEach((scene) =>
    want(
      status.some((line) => line.startsWith(`${scene.profileId} open `)),
      `status lacks ${scene.profileId} open: ${status.join(" / ")}`,
    ),
  );
  const error = problems.length > 0 ? { error: problems.join("; ") } : {};
  return { ok: problems.length === 0, ...error, observation: { code: first.code, status } };
}

/** SIGTERM to every Chrome process of the root, then waits until none is left. */
async function quitAll(rig: Rig): Promise<void> {
  for (const pid of await rig.survivors()) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  for (const deadline = Date.now() + QUIT_MS; Date.now() < deadline; await delay(POLL_MS))
    if ((await rig.survivors()).length === 0) return;
}

/** One sample: prepare a rig, run first-run and status, and leave nothing of the root behind. */
export async function firstRunSample(setup: () => Promise<FirstRunPair>): Promise<Sample> {
  const rig = await setup();
  try {
    const sample = await measure(rig).catch(async (error: unknown) => {
      await rig.keep?.().catch(() => undefined);
      throw error;
    });
    if (!sample.ok) await rig.keep?.().catch(() => undefined);
    return sample;
  } finally {
    try {
      await quitAll(rig);
    } finally {
      await rig.dispose();
    }
  }
}

/** The cell of P4.6 on a shared root, with its topology. */
export const FIRST_RUN_CELLS = {
  "P4.6.firstRun.sharedRoot":
    "two profiles of one root downloading to one folder, empty record: first-run binds, registers, and opens both",
} as const;
export type FirstRunHypothesis = keyof typeof FIRST_RUN_CELLS;

/** Records one P4.6 lab verdict through outcome.ts, in the target's verdicts folder. */
export async function recordFirstRun(
  hypothesis: FirstRunHypothesis,
  target: VerdictTarget,
  take: () => Promise<Sample>,
) {
  const cell: Cell = {
    experiment: "P4.6",
    hypothesis,
    chrome: await target.chrome(),
    environment: target.environment,
    install: "loadUnpacked",
    label: "diagnostic",
    externalClient: true,
    variant: "poc-d0",
    topology: FIRST_RUN_CELLS[hypothesis],
    debugger: "none",
  };
  const directory = target.directory?.();
  return recordHypothesis(cell, take, directory === undefined ? {} : { directory });
}
