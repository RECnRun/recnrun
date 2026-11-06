import { execFile } from "node:child_process";
import { appendFile, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { connectWebSocket, openPage } from "../../browser/fixtures/cdp-client.ts";
import { interruptChrome } from "../../browser/fixtures/chrome-quit.ts";
import { attachExtension } from "../../browser/fixtures/extension-loaders.ts";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import { recordHypothesis } from "../outcome.ts";
import type { Cell } from "../outcome.ts";
import type { Sample, VerdictTarget } from "./downloads-verdicts.ts";

/*
 * The samples of P4.3 (POC PLAN.md), shared by the lab spec and its host twin: poc-d0 installed on
 * a root and kept by one reload, then scripts/poc-cross-profile/open.sh opens the profile with a
 * fresh token and waits for the ack, and a second open meets the running profile.
 */

const OPEN = fileURLToPath(new URL("../../../scripts/poc-cross-profile/open.sh", import.meta.url));
export const EXTENSION_ID_FILE = fileURLToPath(
  new URL("../../../scripts/poc-cross-profile/extension-id", import.meta.url),
);
const NAMESPACE = "lab";
const OPEN_TIMEOUT_S = 60;
const READY_MS = 15_000;
const POLL_MS = 100;
const QUIT_MS = 15_000;
const ACK_BYTES = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A registered profile: its root, the Downloads root it writes to, and the launcher record. */
export interface Scene {
  root: string;
  downloads: string;
  record: string;
  profileId: string;
  profileDirectory: string;
}

/** What one `open.sh open` printed and how it ended; `pid` is Chrome's, from stderr. */
export interface Opened {
  code: number;
  root: string;
  boot: string;
  token: string;
  pid: number;
  ms: number;
  stderr: string;
}

/** A prepared root with the environment of its `open.sh` and the ways to stop and remove it. */
export interface Rig {
  scene: Scene;
  env: NodeJS.ProcessEnv;
  /** The pids of Chrome processes still running on the root. */
  survivors(): Promise<number[]>;
  /** Saves what a failed sample leaves to read. */
  keep?(): Promise<void>;
  /** Problems with the Chrome a successful open started, read while it runs (the host twin's flag). */
  inspect?(opened: Opened): Promise<string[]>;
  dispose(): Promise<void>;
}

/** Polls `read` until it gives a value or `ms` pass. */
export async function until<T>(read: () => Promise<T | undefined>, what: string, ms = READY_MS) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${what} within ${ms} ms`);
    await delay(POLL_MS);
  }
}

const presenceFile = (downloads: string, profileId: string) =>
  join(downloads, "RECnRun/poc", NAMESPACE, "peers", profileId, "presence.json");

export const readJson = async (path: string) =>
  JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

/** Preferences for a root; Developer mode is not here, since Windows and macOS reset a hand-written value (CHROMIUM.md group 16). */
export const preferencesOf = (downloads: string) => ({
  download: { prompt_for_download: false, default_directory: downloads, directory_upgrade: true },
});

const profileIdOf = (extension: LoadedExtension) =>
  until(async () => {
    const id = await extension.evaluateInBackground(
      `chrome.storage.local.get("profileIdentity").then((got) => got.profileIdentity?.profileId)`,
    );
    return typeof id === "string" ? id : undefined;
  }, "poc-d0 stored no profile id");

/** Developer mode through Chrome's own toggle: after the reload the build is an ordinary unpacked one and needs it (CHROMIUM.md group 16). */
async function turnOnDeveloperMode({ chrome }: LoadedExtension): Promise<void> {
  const client = await connectWebSocket(chrome.wsEndpoint);
  const page = await openPage(client, "chrome://extensions/").catch((error: unknown) => {
    client.close();
    throw error;
  });
  try {
    await page.evaluate(
      "chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })",
    );
    const on = "chrome.developerPrivate.getProfileConfiguration().then((c) => c.inDeveloperMode)";
    await until(
      async () => ((await page.evaluate(on)) === true ? true : undefined),
      "Developer mode",
    );
  } finally {
    await page.close();
    client.close();
  }
}

/** Waits for the first presence, reloads the build so Chrome keeps it, writes the record; returns the scene. */
export async function registerIn(
  extension: LoadedExtension,
  {
    root,
    downloads,
    record,
    profileDirectory,
    prepare,
  }: Omit<Scene, "profileId"> & { prepare?: (extension: LoadedExtension) => Promise<void> },
): Promise<Scene> {
  // connectOverCDP routes every download to Playwright's own folder; Chrome's must take the writes.
  await extension.chrome.cdp.send("Browser.setDownloadBehavior", { behavior: "default" });
  const profileId = await profileIdOf(extension);
  await until(() => readFile(presenceFile(downloads, profileId)), "the first presence", 30_000);
  await turnOnDeveloperMode(extension);
  // The reload below closes the session, and the storage written here survives it.
  await prepare?.(extension);
  // The reload drops the CDP install flag that makes Chrome delete the extension at its next start.
  await extension.evaluateInBackground("chrome.runtime.reload()").catch(() => undefined);
  await until(
    () => attachExtension(extension.chrome, extension.extensionId).then((again) => again.close()),
    "poc-d0 did not come back after its reload",
  ).catch(() => undefined);
  const block = [
    `userDataDir=${root}`,
    `profileDirectory=${profileDirectory}`,
    `profileId=${profileId}`,
    `namespace=${NAMESPACE}`,
    `downloadsRoot=${downloads}`,
  ];
  // A second profile's block is appended after a blank line, as the record keeps them.
  const known = await readFile(record, "utf8").catch(() => "");
  await appendFile(record, `${known === "" ? "" : "\n"}${block.join("\n")}\n`);
  return { root, downloads, record, profileId, profileDirectory };
}

/** `register` for the Default profile of `root`. */
export const register = (
  extension: LoadedExtension,
  root: string,
  downloads: string,
  record: string,
) => registerIn(extension, { root, downloads, record, profileDirectory: "Default" });

/** The `key=value` lines of stdout and the `pid=` of stderr. */
export function parseOpened(stdout: string, stderr: string) {
  const fields: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1);
  }
  return {
    root: fields.root ?? "",
    boot: fields.boot ?? "",
    token: fields.token ?? "",
    pid: Number(/pid=(\d+)/.exec(stderr)?.[1] ?? 0),
  };
}

/** One `open.sh open`, run without a shell string; a non-zero exit is a result, not a throw. */
export function runOpen(
  { scene, env }: Pick<Rig, "scene" | "env">,
  mode?: "headed" | "headless",
): Promise<Opened> {
  const started = Date.now();
  const args = [OPEN, "open", scene.record, NAMESPACE, scene.profileId, ...(mode ? [mode] : [])];
  const options = { env: { ...env, RECNRUN_OPEN_TIMEOUT_S: String(OPEN_TIMEOUT_S) } };
  return new Promise((resolve) => {
    execFile("sh", args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error ? ((error as { code?: number }).code ?? 1) : 0;
      resolve({ code, ...parseOpened(stdout, stderr), ms: Date.now() - started, stderr });
    });
  });
}

/** What the printed result of an open must satisfy; `boot` is the token itself on a fresh start. */
export function openProblems(downloads: string, opened: Opened, previous?: Opened): string[] {
  const problems: string[] = [];
  const want = (ok: boolean, text: string) => ok || problems.push(text);
  want(opened.code === 0, `open.sh exited ${opened.code}: ${opened.stderr.trim().slice(-300)}`);
  want(opened.root === downloads, `root was ${opened.root}, expected ${downloads}`);
  want(UUID.test(opened.token), `token ${opened.token} is no v4 uuid`);
  if (!previous) {
    want(opened.boot === opened.token, `boot ${opened.boot} was not the token ${opened.token}`);
    return problems;
  }
  want(opened.token !== previous.token, "the second token repeated the first");
  want(opened.boot === previous.boot, `boot ${opened.boot} was not the running ${previous.boot}`);
  return problems;
}

/** The ack file of the open on disk and the presence of its boot; each failed expectation is a problem. */
export async function ackProblems(scene: Scene, opened: Opened): Promise<string[]> {
  const folder = join(scene.downloads, "RECnRun/poc", NAMESPACE, "acks", scene.profileId);
  const file = join(folder, `${opened.token}.json`);
  try {
    const problems: string[] = [];
    const size = (await stat(file)).size;
    if (size > ACK_BYTES) problems.push(`the ack held ${size} bytes`);
    const ack = await readJson(file);
    const keys = Object.keys(ack).join(",");
    if (keys !== "token,profileId,identity,boot,createdAt") problems.push(`ack keys ${keys}`);
    const got = [ack.token, ack.profileId, ack.boot].join(" ");
    const want = [opened.token, scene.profileId, opened.boot].join(" ");
    if (got !== want) problems.push(`ack carried ${got}, expected ${want}`);
    return [...problems, ...(await presenceProblems(scene, opened.boot))];
  } catch (error) {
    return [`no readable ack ${file}: ${String(error)}`];
  }
}

/** The presence on disk carries `boot`, waiting for a rewrite still under way. */
async function presenceProblems(scene: Scene, boot: string): Promise<string[]> {
  const bootOf = async () => (await readJson(presenceFile(scene.downloads, scene.profileId))).boot;
  await until(async () => ((await bootOf()) === boot ? true : undefined), "presence").catch(
    () => undefined,
  );
  const seen = await bootOf().catch(String);
  return seen === boot ? [] : [`the presence carried ${String(seen)}, expected the boot ${boot}`];
}

/** Chrome's temporary files in the Downloads root: each is a download whose target is not settled (CHROMIUM.md group 15). */
const unfinished = async (downloads: string) =>
  (await readdir(downloads)).filter((name) => name.startsWith(".com.google.Chrome."));

export async function settledProblems(downloads: string): Promise<string[]> {
  const settled = async () => ((await unfinished(downloads)).length === 0 ? true : undefined);
  await until(settled, "unfinished downloads").catch(() => undefined);
  const left = await unfinished(downloads);
  return left.length === 0 ? [] : [`unfinished downloads: ${left.join(", ")}`];
}

/** One open, and with `again` a second on the running profile; every check is a problem, not a throw. */
async function measure(rig: Rig, again: boolean, pids: number[]): Promise<Sample> {
  const { downloads } = rig.scene;
  const first = await runOpen(rig);
  pids.push(first.pid);
  const observation: Record<string, unknown> = { fresh: { ...first, stderr: undefined } };
  const problems = openProblems(downloads, first);
  if (first.code === 0) problems.push(...(await ackProblems(rig.scene, first)));
  if (first.code === 0) problems.push(...((await rig.inspect?.(first)) ?? []));
  if (again && first.code === 0) {
    const second = await runOpen(rig);
    pids.push(second.pid);
    observation.running = { ...second, stderr: undefined };
    problems.push(...openProblems(downloads, second, first));
    if (second.code === 0) problems.push(...(await ackProblems(rig.scene, second)));
  }
  problems.push(...(await settledProblems(downloads)));
  const error = problems.length > 0 ? { error: problems.join("; ") } : {};
  return { ok: problems.length === 0, ...error, observation };
}

/** SIGINT to the pids open.sh printed (0 when it printed none), then until nothing of the root runs. */
export async function quit(rig: Pick<Rig, "survivors">, pids: number[]): Promise<void> {
  await interruptChrome(pids, () => rig.survivors(), QUIT_MS);
}

/** One sample: prepare a rig, measure, stop only the Chrome open.sh spawned, and leave nothing behind. */
export async function openSample(setup: () => Promise<Rig>, again: boolean): Promise<Sample> {
  const rig = await setup();
  const pids: number[] = [];
  try {
    let sample = await measure(rig, again, pids).catch(async (error: unknown) => {
      await rig.keep?.().catch(() => undefined);
      throw error;
    });
    await quit(rig, pids);
    const left = await unfinished(rig.scene.downloads);
    if (left.length > 0)
      sample = { ...sample, ok: false, error: `left after quit: ${left.join(", ")}` };
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

/** The two cells of P4.3, with their topologies. */
export const OPEN_CELLS = {
  "P4.3.open.fresh": "one registered profile, closed: open.sh starts Chrome and gets the ack",
  "P4.3.open.running": "one registered profile, running: a second open.sh meets its boot",
} as const;
export type OpenHypothesis = keyof typeof OPEN_CELLS;

/** Records one P4.3 verdict through outcome.ts, in the target's verdicts folder. */
export async function recordOpen(
  hypothesis: OpenHypothesis,
  target: VerdictTarget,
  take: () => Promise<Sample>,
) {
  const cell: Cell = {
    experiment: "P4.3",
    hypothesis,
    chrome: await target.chrome(),
    environment: target.environment,
    install: "loadUnpacked",
    label: "diagnostic",
    externalClient: true,
    variant: "poc-d0",
    topology: OPEN_CELLS[hypothesis],
    debugger: "none",
  };
  const directory = target.directory?.();
  return recordHypothesis(cell, take, directory === undefined ? {} : { directory });
}
