import { spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  acksOf,
  alive,
  bareRig,
  chromesOf,
  installedRig,
  pidOf,
  presenceOf,
  request,
  sample,
  sharedRig,
  stateOf,
  unfinished,
  verb,
  waitFor,
} from "./e9-rig.ts";
import type { E9Rig, Tally } from "./e9-rig.ts";
import { readJson } from "./fixtures/launcher-open.ts";
import { recordHypothesis } from "./outcome.ts";
import type { Cell, Sample } from "./outcome.ts";
import type { VerdictTarget } from "./fixtures/downloads-verdicts.ts";

/*
 * The cells of E9 (POC PLAN.md P4.4): scripts/poc-cross-profile/lifecycle.sh drives real Chrome
 * roots. The silent-but-alive pause rule is not here: an open.sh-launched Chrome has no CDP client
 * to silence its presence, so lifecycle.checks.mjs covers it.
 */

/** Each cell, its topology, and its full sample count. */
export const E9_CELLS = {
  "E9.duplicate": ["three requests on one closed profile: two together, one during the open", 3],
  "E9.idempotent": ["a request on a running profile with a fresh presence", 3],
  "E9.backoff": ["a registered root whose Chrome never acks: failed, then refused until nextAt", 3],
  "E9.restart": ["the launched Chrome killed, its presence expired, a request relaunches", 3],
  "E9.stop": ["stop signals the launched Chrome only, beside a bystander Chrome", 3],
  "E9.pause": ["a paused profile is not launched; resumed, it is", 3],
  "E9.sharedRoot": ["two profiles of one root, Default open: the second is forwarded", 3],
} as const;
export type E9Hypothesis = keyof typeof E9_CELLS;

const mainsOf = (rig: E9Rig) => chromesOf(rig.root, true);
const SIGNAL_MS = 20_000;
const EXPIRY_MS = 90_000;

async function duplicate(rig: E9Rig, { check, seen }: Tally) {
  // Two start together (the profile lock decides) and a third arrives while the open is under way.
  const late = delay(300).then(() => request(rig));
  const both = await Promise.all([request(rig), request(rig), late]);
  const codes = both.map((ran) => ran.code).sort((a, b) => a - b);
  seen.codes = codes;
  check(codes.join() === "0,75,75", `exit codes ${codes.join()}, expected 0,75,75`);
  const mains = await mainsOf(rig);
  check(mains.length === 1, `${mains.length} Chrome main processes of the root, expected 1`);
  check((await acksOf(rig)) === 1, `${await acksOf(rig)} ack files, expected 1`);
  check((await stateOf(rig)).status === "open", "the state is not open");
}

async function idempotent(rig: E9Rig, { check, seen }: Tally) {
  const first = await request(rig);
  const before = await mainsOf(rig);
  const again = await request(rig);
  seen.boots = [first.boot, again.boot];
  check(first.code === 0 && again.code === 0, `exit codes ${first.code}, ${again.code}`);
  check(
    first.boot !== "" && again.boot === first.boot,
    "the second request did not print the known boot",
  );
  check((await mainsOf(rig)).join() === before.join(), "the second request started a Chrome");
  check((await acksOf(rig)) === 1, `${await acksOf(rig)} ack files, expected 1`);
}

async function backoff(rig: E9Rig, { check, seen }: Tally) {
  const env = { RECNRUN_OPEN_TIMEOUT_S: "3", RECNRUN_LIFECYCLE_BACKOFF_S: "60" };
  const first = await request(rig, env);
  const state = await stateOf(rig);
  const before = await mainsOf(rig);
  const second = await request(rig, env);
  seen.state = state;
  check(first.code === 70 || first.code === 69, `the first request exited ${first.code}`);
  check(
    state.status === "failed" && state.attempts === "1",
    `state ${state.status}, attempts ${state.attempts}`,
  );
  check(Number(state.nextAt) > Math.floor(Date.now() / 1000), "nextAt is not in the future");
  check(second.code === 70, `the second request exited ${second.code}, expected 70`);
  check((await mainsOf(rig)).join() === before.join(), "the second request started a Chrome");
  // The timed-out Chrome is still running; stop must end it through the pid the failed open recorded.
  const pid = await pidOf(rig);
  check(pid > 0 && alive(pid), "the state does not name the timed-out Chrome");
  const stopped = await verb(rig, "stop", { RECNRUN_LIFECYCLE_STOP_S: "20" });
  check(stopped.code === 0, `stop exited ${stopped.code}: ${stopped.err.trim().slice(-200)}`);
  check(!alive(pid) && (await mainsOf(rig)).length === 0, "stop left the timed-out Chrome running");
}

/** Waits until the last presence the dead Chrome wrote has expired by lifecycle.sh's clock. */
async function presenceExpired(rig: E9Rig) {
  const stale = async () => {
    const expires = Number((await readJson(presenceOf(rig))).expiresAt);
    // lifecycle.sh reads the clock in whole seconds, so it sees a second less than Date.now().
    return expires + 1000 <= Date.now() ? expires : undefined;
  };
  return waitFor(stale, EXPIRY_MS);
}

async function restart(rig: E9Rig, { check, seen }: Tally) {
  const first = await request(rig);
  const pid = await pidOf(rig);
  process.kill(pid, "SIGTERM");
  const gone = async () => ((await chromesOf(rig.root)).length === 0 ? true : undefined);
  check(Boolean(await waitFor(gone, SIGNAL_MS)), "the crashed Chrome did not exit");
  check((await presenceExpired(rig)) !== undefined, "the presence never expired");
  const again = await request(rig);
  const state = await stateOf(rig);
  seen.boots = [first.boot, again.boot];
  check(again.code === 0, `the relaunch exited ${again.code}: ${again.err.trim().slice(-200)}`);
  check(Number(state.pid) !== pid && alive(Number(state.pid)), "no new Chrome pid");
  check(again.boot !== "" && again.boot !== first.boot, "the boot did not change");
  check(state.status === "open", `status ${state.status}`);
}

/** A Chrome of another root, started beside the rig's, that stop must leave alone. */
function bystander(rig: E9Rig) {
  const root = join(rig.dir, "Bystander");
  const flags = [
    `--user-data-dir=${root}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ];
  return spawn(join(rig.bin, "google-chrome"), flags, { env: rig.env, stdio: "ignore" });
}

async function stop(rig: E9Rig, { check, seen }: Tally) {
  await request(rig);
  const pid = await pidOf(rig);
  const other = bystander(rig);
  try {
    const started = Date.now();
    const stopped = await verb(rig, "stop", { RECNRUN_LIFECYCLE_STOP_S: "20" });
    seen.ms = Date.now() - started;
    check(stopped.code === 0, `stop exited ${stopped.code}: ${stopped.err.trim().slice(-200)}`);
    check(
      !alive(pid) && (await chromesOf(rig.root)).length === 0,
      "the root's Chrome is still there",
    );
    check(other.pid !== undefined && alive(other.pid), "stop touched the bystander Chrome");
    check((await stateOf(rig)).status === "stopped", "the state is not stopped");
    const held = await request(rig);
    seen.heldCode = held.code;
    check(held.code === 73, `a request after stop exited ${held.code}, expected 73`);
    check((await mainsOf(rig)).length === 0, "a request after stop launched a Chrome");
    check(
      (await unfinished(rig)).length === 0,
      `unfinished downloads: ${(await unfinished(rig)).join(", ")}`,
    );
  } finally {
    other.kill("SIGKILL");
  }
}

async function pause(rig: E9Rig, { check, seen }: Tally) {
  await request(rig);
  await verb(rig, "stop");
  await verb(rig, "pause");
  const refused = await request(rig);
  seen.refused = refused.code;
  check(refused.code === 73, `the paused request exited ${refused.code}, expected 73`);
  check((await mainsOf(rig)).length === 0, "the paused request launched a Chrome");
  await verb(rig, "resume");
  const resumed = await request(rig);
  check(
    resumed.code === 0,
    `the resumed request exited ${resumed.code}: ${resumed.err.trim().slice(-200)}`,
  );
  check((await mainsOf(rig)).length === 1, "the resumed request did not launch a Chrome");
}

async function sharedRoot(rig: E9Rig, { check, seen }: Tally) {
  const first = await request({ ...rig, profileId: rig.firstId ?? "" });
  const second = await request(rig);
  const state = await stateOf(rig);
  const mains = await mainsOf(rig);
  seen.mains = mains;
  seen.pid = state.pid;
  check(first.code === 0, `the first profile's request exited ${first.code}`);
  check(second.code === 0, `the second request exited ${second.code}: ${second.err.trim()}`);
  check(
    state.status === "open" && state.shared === "1",
    `state ${state.status}, shared ${state.shared}`,
  );
  check(
    mains.length === 1 && Number(state.pid) === mains[0],
    `the pid of record ${state.pid} is not the root's one main process ${mains.join()}`,
  );
  const stopped = await verb(rig, "stop", { RECNRUN_LIFECYCLE_STOP_S: "2" });
  seen.stop = stopped.code;
  check(stopped.code === 70, `stop exited ${stopped.code}, expected 70`);
  check(/shared root .*close its window instead/.test(stopped.err), "stop did not say why");
  check(mains[0] !== undefined && alive(mains[0]), "stop closed the root's Chrome");
}

const BODIES: Record<
  E9Hypothesis,
  [() => Promise<E9Rig>, (rig: E9Rig, tally: Tally) => Promise<void>]
> = {
  "E9.duplicate": [installedRig, duplicate],
  "E9.idempotent": [installedRig, idempotent],
  "E9.backoff": [bareRig, backoff],
  "E9.restart": [installedRig, restart],
  "E9.stop": [installedRig, stop],
  "E9.pause": [installedRig, pause],
  "E9.sharedRoot": [sharedRig, sharedRoot],
};

/** One sample of a cell: a fresh rig, the cell's body, everything stopped and removed. */
const takeCell = (hypothesis: E9Hypothesis): Promise<Sample> => {
  const [setup, body] = BODIES[hypothesis];
  return sample(setup, body);
};

/** Records one E9 verdict through outcome.ts, in the target's verdicts folder. */
export async function recordE9(hypothesis: E9Hypothesis, target: VerdictTarget) {
  const [topology, full] = E9_CELLS[hypothesis];
  const cell: Cell = {
    experiment: "E9",
    hypothesis,
    chrome: await target.chrome(),
    environment: target.environment,
    install: "loadUnpacked",
    label: "diagnostic",
    externalClient: true,
    variant: "poc-d0",
    topology,
    debugger: "none",
  };
  const directory = target.directory?.();
  return recordHypothesis(cell, () => takeCell(hypothesis), {
    full,
    ...(directory === undefined ? {} : { directory }),
  });
}
