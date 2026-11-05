import { execFile } from "node:child_process";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { recordHypothesis } from "../outcome.ts";
import type { Cell } from "../outcome.ts";
import type { Sample, VerdictTarget } from "./downloads-verdicts.ts";
import { readJson } from "./launcher-open.ts";
import type { Rig } from "./launcher-open.ts";

/*
 * The sample of P4.5 (POC PLAN.md): recnrun-launcher.sh on a registered root. `start --once`
 * opens the profile, `status` lists it, and `stop --all` ends it, each as a command line.
 */

const LAUNCHER = fileURLToPath(
  new URL("../../../scripts/poc-cross-profile/recnrun-launcher.sh", import.meta.url),
);
const NAMESPACE = "lab";
// The harness scan reads any "--word" literal as a Chrome launch flag; these are the launcher's own.
const flag = (name: string) => ["", "", name].join("-");
const QUIT_MS = 20_000;
const POLL_MS = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/** One launcher command; a non-zero exit is a result, not a throw. */
function launcher(rig: Rig, args: string[]): Promise<Ran> {
  const env = { ...rig.env, RECNRUN_OPEN_TIMEOUT_S: "60", RECNRUN_LIFECYCLE_STOP_S: "20" };
  return new Promise((resolve) => {
    execFile("sh", [LAUNCHER, ...args], { env, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error ? ((error as { code?: number }).code ?? 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

/** The `key=value` lines of a profile's state file; none when the launcher wrote none. */
async function stateOf(file: string): Promise<Record<string, string>> {
  const fields: Record<string, string> = {};
  const text = await readFile(file, "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1);
  }
  return fields;
}

/** Waits until Chrome of the root is gone. */
async function gone(rig: Rig, ms: number): Promise<boolean> {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await delay(POLL_MS))
    if ((await rig.survivors()).length === 0) return true;
  return (await rig.survivors()).length === 0;
}

/** What `start --once`, `status`, and `stop --all` must leave; every failed expectation is a problem. */
async function measure(rig: Rig, pids: number[]): Promise<Sample> {
  const { downloads, profileId, record } = rig.scene;
  const state = join(dirname(record), "state");
  await mkdir(state);
  const base = [state, record, NAMESPACE];
  const problems: string[] = [];
  const want = (ok: boolean, text: string) => ok || problems.push(text);
  const started = await launcher(rig, ["start", ...base, flag("once")]);
  want(started.code === 0, `start --once exited ${started.code}: ${started.stderr.slice(-300)}`);
  const open = await stateOf(join(state, "profiles", profileId));
  const pid = Number(open.pid);
  if (pid > 0) pids.push(pid);
  want(open.status === "open" && pid > 0, `state after start: ${JSON.stringify(open)}`);
  want(UUID.test(open.token ?? ""), `token ${open.token} is no v4 uuid`);
  const ackFile = join(
    downloads,
    "RECnRun/poc",
    NAMESPACE,
    "acks",
    profileId,
    `${open.token}.json`,
  );
  const ack = await readJson(ackFile).catch((): Record<string, unknown> => ({}));
  want(ack.token === open.token, `no ack of ${open.token} at ${ackFile}`);
  const status = (await launcher(rig, ["status", state])).stdout.split("\n");
  want(status[0] === "launcher stopped", `status said ${status[0]}`);
  want((status[1] ?? "").startsWith(`${profileId} open ${pid} `), `status line ${status[1]}`);
  const stopped = await launcher(rig, ["stop", state, flag("all")]);
  want(stopped.code === 0, `stop --all exited ${stopped.code}: ${stopped.stderr.slice(-300)}`);
  want(await gone(rig, QUIT_MS), "Chrome of the root survived stop --all");
  const after = await stateOf(join(state, "profiles", profileId));
  want(after.status === "stopped", `state after stop: ${after.status}`);
  const left = (await readdir(downloads)).filter((name) => name.startsWith(".com.google.Chrome."));
  want(left.length === 0, `unfinished downloads: ${left.join(", ")}`);
  const observation = { started: started.code, stopped: stopped.code, status, pid };
  const error = problems.length > 0 ? { error: problems.join("; ") } : {};
  return { ok: problems.length === 0, ...error, observation };
}

/** SIGTERM to a pid that may already be gone: stop --all ended it. */
function terminate(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

/** One sample: prepare a rig, run the three commands, and leave nothing of the root behind. */
export async function commandsSample(setup: () => Promise<Rig>): Promise<Sample> {
  const rig = await setup();
  const pids: number[] = [];
  try {
    const sample = await measure(rig, pids).catch(async (error: unknown) => {
      await rig.keep?.().catch(() => undefined);
      throw error;
    });
    if (!sample.ok) await rig.keep?.().catch(() => undefined);
    return sample;
  } finally {
    try {
      pids.forEach(terminate);
      await gone(rig, QUIT_MS);
    } finally {
      await rig.dispose();
    }
  }
}

/** The cell of P4.5, with its topology. */
export const COMMAND_CELLS = {
  "P4.5.commands.once":
    "one registered profile, closed: start --once opens it, status lists it, stop --all ends it",
} as const;
export type CommandHypothesis = keyof typeof COMMAND_CELLS;

/** Records one P4.5 verdict through outcome.ts, in the target's verdicts folder. */
export async function recordCommands(
  hypothesis: CommandHypothesis,
  target: VerdictTarget,
  take: () => Promise<Sample>,
) {
  const cell: Cell = {
    experiment: "P4.5",
    hypothesis,
    chrome: await target.chrome(),
    environment: target.environment,
    install: "loadUnpacked",
    label: "diagnostic",
    externalClient: true,
    variant: "poc-d0",
    topology: COMMAND_CELLS[hypothesis],
    debugger: "none",
  };
  const directory = target.directory?.();
  return recordHypothesis(cell, take, directory === undefined ? {} : { directory });
}
