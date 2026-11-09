import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { EXTENSION, environment } from "../../../../scripts/poc-cross-profile/base-lab.mjs";
import { installScene } from "../../../../scripts/poc-cross-profile/install-lab.mjs";
import { alive } from "../../../../scripts/poc-cross-profile/lifecycle-lab.mjs";

export const launcher = fileURLToPath(new URL("./launcher.sh", import.meta.url));
export const EX_USAGE = 64;
export const EX_FAILED = 70;
export const EX_LOCKED = 75;

export async function waitFor(condition, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return;
    await delay(25);
  }
  throw new Error(`timed out after ${ms} ms`);
}

/** The key=value lines of a file as an object; {} when it is missing. */
export function fields(path) {
  if (!existsSync(path)) return {};
  const entries = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]);
  return Object.fromEntries(entries);
}

/** One launcher run; detached, so it has no controlling terminal and /dev/tty cannot open. */
function startRun(shell, args, env, spawned) {
  const child = spawn(shell, [launcher, ...args], { detached: true, env });
  spawned.push(child.pid);
  const run = { pid: child.pid, out: "", err: "", code: undefined };
  child.stdout.on("data", (chunk) => (run.out += chunk));
  child.stderr.on("data", (chunk) => (run.err += chunk));
  run.exited = new Promise((resolve) =>
    child.on("exit", (code, signal) => {
      run.code = code ?? signal;
      resolve(run.code);
    }),
  );
  return run;
}

/** A temporary home with the fake Chrome, its ps, and a lab folder for the launcher. */
export function launcherScene(context, shell) {
  const s = installScene(context);
  const lab = join(s.home, "lab");
  const env = (extra) =>
    environment(s.home, "base-v1", {
      STUB_MESSAGES: join(s.home, "messages"),
      STUB_EXTENSION: EXTENSION,
      STUB_BUILD: join(lab, "roots/w1/ext"),
      TMPDIR: s.home,
      RECNRUN_LAB_TICK_S: "0.2",
      RECNRUN_LAB_HEARTBEAT_S: "0.2",
      RECNRUN_LAB_STOP_S: "2",
      ...extra,
    });
  context.after(() => {
    for (const pid of s.spawned) if (alive(pid)) process.kill(pid, "SIGKILL");
  });
  return {
    ...s,
    lab,
    ws: join(lab, "workspace"),
    state: join(lab, "state"),
    start: (args = ["--allow", "http://127.0.0.1:4600"], extra = {}) =>
      startRun(shell, ["start", lab, ...args], env(extra), s.spawned),
    heartbeat: () => fields(join(lab, "workspace/launcher/heartbeat")),
  };
}
