import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { TestInfo } from "@playwright/test";
import { expect, resolveChromePath, test } from "./fixtures/chrome.ts";
import { POC_EXTENSION_ID } from "./fixtures/downloads-profiles.ts";
import { attachExtension, extensionPath, loadUnpacked } from "./fixtures/extension-loaders.ts";
import type { LoadedExtension } from "./fixtures/extension-loaders.ts";
import { keepDisplayOnFailure } from "./fixtures/x-display.ts";

/*
 * POC PLAN.md P4.3 on Google Chrome Stable: the launcher's open.sh starts a second root's Chrome
 * with the bootstrap URL on its command line and waits for the ack the extension writes under that
 * profile's Downloads root. The root is prepared the lab's way (poc-d0 by Extensions.loadUnpacked,
 * reloaded once so it outlives the process, see CHROMIUM.md group 9), then quit with SIGTERM.
 */

const OPEN = fileURLToPath(new URL("../../scripts/poc-cross-profile/open.sh", import.meta.url));
const EXTENSION_ID_FILE = fileURLToPath(
  new URL("../../scripts/poc-cross-profile/extension-id", import.meta.url),
);
const NAMESPACE = "lab";
const OPEN_TIMEOUT_S = 60;
const READY_MS = 15_000;
const POLL_MS = 100;
const QUIT_MS = 15_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface Prepared {
  home: string;
  root: string;
  downloads: string;
  record: string;
  profileId: string;
  /** A folder with a `google-chrome` that adds the sandbox flag the container needs. */
  bin: string;
}

interface Opened {
  code: number;
  root: string;
  boot: string;
  token: string;
  pid: number;
  ms: number;
}

/** Polls `read` until it gives a value or `ms` pass. */
async function until<T>(read: () => Promise<T | undefined>, what: string, ms = READY_MS) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${what} within ${ms} ms`);
    await delay(POLL_MS);
  }
}

/** The pids whose command line names `root` as the user data directory (Linux /proc only). */
async function chromesOf(root: string): Promise<number[]> {
  const found: number[] = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const line = await readFile(`/proc/${name}/cmdline`, "utf8").catch(() => "");
    if (line.includes(`--user-data-dir=${root}`)) found.push(Number(name));
  }
  return found;
}

/** A wrapper first on PATH, so open.sh finds `google-chrome` and the container's Chrome gets its flag. */
async function wrapper(dir: string): Promise<string> {
  const bin = join(dir, "bin");
  await mkdir(bin);
  const sandbox = process.env.RECNRUN_TEST_CONTAINER === "1" ? " --no-sandbox" : "";
  const script = `#!/bin/sh\nexec "${resolveChromePath()}"${sandbox} "$@" 2>>"${dir}/chrome.log"\n`;
  // profiles.sh tries google-chrome-stable first, and the image has one in /usr/bin.
  for (const name of ["google-chrome-stable", "google-chrome"]) {
    await writeFile(join(bin, name), script);
    await chmod(join(bin, name), 0o755);
  }
  return bin;
}

const profileIdOf = (extension: LoadedExtension) =>
  until(async () => {
    const id = await extension.evaluateInBackground(
      `chrome.storage.local.get("profileIdentity").then((got) => got.profileIdentity?.profileId)`,
    );
    return typeof id === "string" ? id : undefined;
  }, "poc-d0 stored no profile id");

const presenceFile = (downloads: string, profileId: string) =>
  join(downloads, "RECnRun/poc", NAMESPACE, "peers", profileId, "presence.json");

/** poc-d0 installed on a fresh root, reloaded so Chrome keeps it, and quit; returns the registered profile. */
async function prepare(dir: string): Promise<Prepared> {
  const home = join(dir, "home");
  const root = join(dir, "Chrome");
  const downloads = join(home, "Downloads");
  await mkdir(join(root, "Default"), { recursive: true });
  await mkdir(downloads, { recursive: true });
  // Developer mode stays on, or Chrome disables an unpacked extension once it is reloaded.
  const preferences = {
    download: { prompt_for_download: false, default_directory: downloads, directory_upgrade: true },
    extensions: { ui: { developer_mode: true } },
  };
  await writeFile(join(root, "Default", "Preferences"), JSON.stringify(preferences));
  const extension = await loadUnpacked(extensionPath("poc-d0"), { userDataDir: root });
  try {
    // connectOverCDP routes every download to Playwright's own folder; Chrome's must take the writes.
    await extension.chrome.cdp.send("Browser.setDownloadBehavior", { behavior: "default" });
    const profileId = await profileIdOf(extension);
    await until(() => readFile(presenceFile(downloads, profileId)), "the first presence", 30_000);
    // The reload drops the CDP install flag that makes Chrome delete the extension at its next start.
    await extension.evaluateInBackground("chrome.runtime.reload()").catch(() => undefined);
    await until(
      () => attachExtension(extension.chrome, extension.extensionId).then((again) => again.close()),
      "poc-d0 did not come back after its reload",
    ).catch(() => undefined);
    const record = join(dir, "launcher.record");
    const block = [
      `userDataDir=${root}`,
      "profileDirectory=Default",
      `profileId=${profileId}`,
      `namespace=${NAMESPACE}`,
      `downloadsRoot=${downloads}`,
    ];
    await writeFile(record, `${block.join("\n")}\n`);
    return { home, root, downloads, record, profileId, bin: await wrapper(dir) };
  } finally {
    await extension.close();
  }
}

/** One `open.sh open`, run without a shell string; Chrome's pid is the one it printed on stderr. */
function open(scene: Prepared): Promise<Opened> {
  const started = Date.now();
  const env = {
    PATH: [scene.bin, process.env.PATH].join(delimiter),
    HOME: scene.home,
    DISPLAY: process.env.DISPLAY ?? "",
    // HOME moves, so the display's authority file must be named, or Chrome finds no X server.
    XAUTHORITY: process.env.XAUTHORITY ?? join(homedir(), ".Xauthority"),
    RECNRUN_TEST_CONTAINER: process.env.RECNRUN_TEST_CONTAINER ?? "",
    RECNRUN_OPEN_TIMEOUT_S: String(OPEN_TIMEOUT_S),
  };
  const args = [OPEN, "open", scene.record, NAMESPACE, scene.profileId];
  return new Promise((resolve, reject) => {
    execFile("sh", args, { env, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error ? ((error as { code?: number }).code ?? 1) : 0;
      const fields = Object.fromEntries(
        stdout.split("\n").flatMap((line) => (line.includes("=") ? [line.split("=")] : [])),
      ) as Record<string, string>;
      const pid = Number(/pid=(\d+)/.exec(stderr)?.[1] ?? 0);
      const ms = Date.now() - started;
      if (code !== 0) return reject(new Error(`open.sh exited ${code} after ${ms} ms: ${stderr}`));
      resolve({
        code,
        root: fields.root ?? "",
        boot: fields.boot ?? "",
        token: fields.token ?? "",
        pid,
        ms,
      });
    });
  });
}

/** Stops the Chrome on `root` the way a person quits it, then waits until none of it is left. */
async function quitRoot(root: string, pids: number[]): Promise<void> {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone: the second open's process hands over to the first and exits.
    }
  }
  await until(
    async () => ((await chromesOf(root)).length === 0 ? true : undefined),
    "Chrome left",
    QUIT_MS,
  );
}

const readJson = async (path: string) =>
  JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

/** The ack of `opened` on disk: the extension's bytes, for the profile, the token, and the boot printed. */
async function checkAck(scene: Prepared, opened: Opened): Promise<void> {
  const folder = join(scene.downloads, "RECnRun/poc", NAMESPACE, "acks", scene.profileId);
  const ackFile = join(folder, `${opened.token}.json`);
  expect((await stat(ackFile)).size).toBeLessThanOrEqual(4096);
  const ack = await readJson(ackFile);
  expect(Object.keys(ack)).toEqual(["token", "profileId", "identity", "boot", "createdAt"]);
  expect([ack.token, ack.profileId, ack.boot]).toEqual([
    opened.token,
    scene.profileId,
    opened.boot,
  ]);
}

/** What a failed run leaves to read: the display, Chrome's stderr, the settings, and the Downloads tree. */
async function keepEvidence(dir: string, scene: Prepared | undefined, testInfo: TestInfo) {
  const status = { status: "failed", expectedStatus: "passed" } as const;
  await keepDisplayOnFailure({ ...status, outputPath: (name) => testInfo.outputPath(name) });
  await copyFile(join(dir, "chrome.log"), testInfo.outputPath("chrome.log")).catch(() => undefined);
  if (!scene) return;
  const tree = (await readdir(scene.downloads, { recursive: true })).join("\n");
  await writeFile(testInfo.outputPath("downloads-tree.txt"), tree);
  const prefs = await readJson(join(scene.root, "Default/Preferences")).catch(
    (): Record<string, unknown> => ({}),
  );
  await writeFile(testInfo.outputPath("extensions.json"), JSON.stringify(prefs.extensions ?? {}));
}

test("open.sh opens a second root's profile, gets the ack of its token, and a running profile acks its own boot", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBeDefined();
  test.setTimeout(240_000);
  const dir = await mkdtemp(join(tmpdir(), "recnrun-open-"));
  const pids: number[] = [];
  let scene: Prepared | undefined;
  try {
    expect((await readFile(EXTENSION_ID_FILE, "utf8")).trim()).toBe(POC_EXTENSION_ID);
    scene = await prepare(dir);
    const first = await open(scene);
    pids.push(first.pid);
    expect(first.root).toBe(scene.downloads);
    expect(first.token).toMatch(UUID);
    expect(first.boot).toBe(first.token);
    await checkAck(scene, first);
    // Observed, not asserted: the presence stays at the previous session's boot (P4.3 run B report).
    const presence = await readJson(presenceFile(scene.downloads, scene.profileId)).catch(
      (): Record<string, unknown> => ({}),
    );
    const seen = `presence boot ${String(presence.boot)}, ack boot ${first.boot}`;

    const second = await open(scene);
    pids.push(second.pid);
    expect(second.token).toMatch(UUID);
    expect(second.token).not.toBe(first.token);
    expect(second.boot).toBe(first.boot);
    await checkAck(scene, second);
    const description = `${seen}; fresh start acked in ${first.ms} ms, running profile in ${second.ms} ms`;
    testInfo.annotations.push({ type: "ack", description });
    console.log(`launcher-open: ${description}`);
  } catch (error) {
    await keepEvidence(dir, scene, testInfo).catch(() => undefined);
    throw error;
  } finally {
    if (scene) await quitRoot(scene.root, [...pids, ...(await chromesOf(scene.root))]);
    expect(scene ? await chromesOf(scene.root) : [], "no Chrome of the root survives").toEqual([]);
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
