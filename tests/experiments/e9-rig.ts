import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { resolveChromePath } from "../browser/fixtures/chrome.ts";
import { loadUnpacked, extensionPath } from "../browser/fixtures/extension-loaders.ts";
import { preferencesOf, register } from "./fixtures/launcher-open.ts";
import type { Sample } from "./outcome.ts";

/*
 * The rigs of E9 (POC PLAN.md P4.4): a throwaway Chrome root with poc-d0 installed and kept by one
 * reload, or a bare root that never acks, and the ways to run lifecycle.sh on it from inside a HOME
 * of the rig. Nothing here touches a Chrome root outside the rig.
 */

const LIFECYCLE = fileURLToPath(
  new URL("../../scripts/poc-cross-profile/lifecycle.sh", import.meta.url),
);
const NAMESPACE = "lab";
const QUIT_MS = 15_000;
const POLL_MS = 100;
// A Chrome child process names its kind; the main process has none (read here, never passed).
const CHILD_FLAG = /^--type=/;

export interface E9Rig {
  dir: string;
  bin: string;
  root: string;
  downloads: string;
  record: string;
  state: string;
  profileId: string;
  env: NodeJS.ProcessEnv;
}

export interface Ran {
  code: number;
  out: string;
  err: string;
  boot: string;
  ms: number;
}

/** Polls `read` until it gives a value or `ms` pass; undefined on the deadline. */
export async function waitFor<T>(read: () => Promise<T | undefined>, ms: number) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value !== undefined || Date.now() > deadline) return value;
    await delay(POLL_MS);
  }
}

/** The pids whose command line names `root` as the user data directory; the main process has no --type. */
export async function chromesOf(root: string, mainOnly = false): Promise<number[]> {
  const found: number[] = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const args = (await readFile(`/proc/${name}/cmdline`, "utf8").catch(() => "")).split("\0");
    if (!args.includes(`--user-data-dir=${root}`)) continue;
    if (!mainOnly || !args.some((arg) => CHILD_FLAG.test(arg))) found.push(Number(name));
  }
  return found;
}

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A wrapper first on PATH, so open.sh finds `google-chrome` and the container's Chrome gets its flag. */
async function wrapper(dir: string): Promise<string> {
  const bin = join(dir, "bin");
  await mkdir(bin);
  const sandbox = process.env.RECNRUN_TEST_CONTAINER === "1" ? " --no-sandbox" : "";
  const script = `#!/bin/sh\nexec "${resolveChromePath()}"${sandbox} "$@" 2>>"${dir}/chrome.log"\n`;
  for (const name of ["google-chrome-stable", "google-chrome"]) {
    await writeFile(join(bin, name), script);
    await chmod(join(bin, name), 0o755);
  }
  return bin;
}

async function skeleton(): Promise<E9Rig> {
  const dir = await mkdtemp(join(tmpdir(), "recnrun-e9-"));
  const home = join(dir, "home");
  const rig: E9Rig = {
    dir,
    bin: await wrapper(dir),
    root: join(dir, "Chrome"),
    downloads: join(home, "Downloads"),
    record: join(dir, "launcher.record"),
    state: join(dir, "state"),
    profileId: "",
    env: {
      HOME: home,
      DISPLAY: process.env.DISPLAY ?? "",
      // HOME moves, so the display's authority file must be named, or Chrome finds no X server.
      XAUTHORITY: process.env.XAUTHORITY ?? join(homedir(), ".Xauthority"),
      RECNRUN_TEST_CONTAINER: process.env.RECNRUN_TEST_CONTAINER ?? "",
    },
  };
  rig.env.PATH = [rig.bin, process.env.PATH].join(delimiter);
  await mkdir(join(rig.root, "Default"), { recursive: true });
  await mkdir(rig.downloads, { recursive: true });
  await mkdir(rig.state);
  await writeFile(
    join(rig.root, "Default/Preferences"),
    JSON.stringify(preferencesOf(rig.downloads)),
  );
  return rig;
}

const dispose = (rig: E9Rig) =>
  rm(rig.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

/** poc-d0 installed on a fresh root, reloaded so Chrome keeps it, and quit. */
export async function installedRig(): Promise<E9Rig> {
  const rig = await skeleton();
  const extension = await loadUnpacked(extensionPath("poc-d0"), { userDataDir: rig.root });
  try {
    const scene = await register(extension, rig.root, rig.downloads, rig.record);
    return { ...rig, profileId: scene.profileId };
  } catch (error) {
    await dispose(rig);
    throw error;
  } finally {
    await extension.close();
  }
}

/** A registered root with no extension: Chrome starts on it and no ack ever arrives. */
export async function bareRig(): Promise<E9Rig> {
  const rig = await skeleton();
  const profileId = randomUUID();
  const block = [
    `userDataDir=${rig.root}`,
    "profileDirectory=Default",
    `profileId=${profileId}`,
    `namespace=${NAMESPACE}`,
    `downloadsRoot=${rig.downloads}`,
  ];
  await writeFile(rig.record, `${block.join("\n")}\n`);
  return { ...rig, profileId };
}

/** One lifecycle.sh run; a non-zero exit is a result, not a throw. */
function life(rig: E9Rig, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<Ran> {
  const started = Date.now();
  const options = { env: { ...rig.env, ...extra }, encoding: "utf8" } as const;
  return new Promise((resolve) => {
    execFile("sh", [LIFECYCLE, ...args], options, (error, out, err) => {
      const code = error ? ((error as { code?: number }).code ?? 1) : 0;
      const boot = /^boot=(.*)$/m.exec(out)?.[1] ?? "";
      resolve({ code, out, err, boot, ms: Date.now() - started });
    });
  });
}

export const request = (rig: E9Rig, extra: NodeJS.ProcessEnv = {}) =>
  life(rig, ["request", rig.state, rig.record, NAMESPACE, rig.profileId], extra);
export const verb = (rig: E9Rig, name: string, extra: NodeJS.ProcessEnv = {}) =>
  life(rig, [name, rig.state, rig.profileId], extra);

/** The key=value lines of the profile's state file, empty before any request. */
export async function stateOf(rig: E9Rig): Promise<Record<string, string>> {
  const text = await readFile(join(rig.state, "profiles", rig.profileId), "utf8").catch(() => "");
  const pairs = text.split("\n").filter((line) => line.includes("="));
  return Object.fromEntries(
    pairs.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

export const pidOf = async (rig: E9Rig) => Number((await stateOf(rig)).pid ?? 0);

export const acksOf = async (rig: E9Rig) =>
  (
    await readdir(join(rig.downloads, "RECnRun/poc", NAMESPACE, "acks", rig.profileId)).catch(
      () => [],
    )
  ).length;

export const presenceOf = (rig: E9Rig) =>
  join(rig.downloads, "RECnRun/poc", NAMESPACE, "peers", rig.profileId, "presence.json");

export const unfinished = async (rig: E9Rig) =>
  (await readdir(rig.downloads)).filter((name) => name.startsWith(".com.google.Chrome."));

/** SIGTERM to the pid the state names and to the main processes of the root, then SIGKILL for stragglers. */
async function shutdown(rig: E9Rig): Promise<string[]> {
  const pids = new Set([await pidOf(rig), ...(await chromesOf(rig.root, true))]);
  for (const pid of pids) if (pid > 0 && alive(pid)) process.kill(pid, "SIGTERM");
  const gone = async () => ((await chromesOf(rig.root)).length === 0 ? true : undefined);
  if (await waitFor(gone, QUIT_MS)) return [];
  for (const pid of await chromesOf(rig.root)) process.kill(pid, "SIGKILL");
  return ["Chrome of the root survived SIGTERM"];
}

/** What a body states: `check` records a problem unless `ok`, `seen` becomes the observation. */
export interface Tally {
  check: (ok: boolean, text: string) => void;
  seen: Record<string, unknown>;
}
type Body = (rig: E9Rig, tally: Tally) => Promise<void>;

/** One sample: build the rig, run the body, stop what it launched, and leave nothing behind. */
export async function sample(setup: () => Promise<E9Rig>, body: Body): Promise<Sample> {
  const rig = await setup();
  const problems: string[] = [];
  const seen: Record<string, unknown> = {};
  const check = (ok: boolean, text: string) => ok || problems.push(text);
  try {
    await body(rig, { check, seen });
  } catch (error) {
    problems.push(String(error));
  } finally {
    problems.push(...(await shutdown(rig)));
    check((await chromesOf(rig.root)).length === 0, "something of the root still runs");
    await dispose(rig);
  }
  const error = problems.length > 0 ? { error: problems.join("; ") } : {};
  return { ok: problems.length === 0, ...error, observation: seen };
}
