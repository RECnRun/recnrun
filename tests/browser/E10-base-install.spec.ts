import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { labEnvironment } from "../experiments/fixtures/e4-lab.ts";
import {
  expectEveryHypothesis,
  recordHypothesis,
  recordUnavailable,
} from "../experiments/outcome.ts";
import type { Cell, Sample } from "../experiments/outcome.ts";
import { sized } from "../experiments/samples.ts";
import { expect, resolveChromePath, test } from "./fixtures/chrome.ts";
import { POC_EXTENSION_ID } from "./fixtures/downloads-profiles.ts";
import { extensionPath } from "./fixtures/extension-loaders.ts";

/*
 * E10 (POC PLAN.md P6.2, CL17) on Google Chrome Stable: scripts/poc-cross-profile/install.sh installs
 * poc-d0 in a clean base over the DevTools pipe and closes Chrome; then base.sh starts the base twice
 * with no debugging flag and no client, and each start must ack its template token. A base root as
 * base.sh create-base writes it holds no extension before the install.
 */

const EXPERIMENT = "E10";
const CELLS = [
  "E10.pipe.load",
  "E10.pipe.persistFirstRelaunch",
  "E10.pipe.persistSecondRelaunch",
  "E10.policy.forcelist",
] as const;
const NAMESPACE = "lab";
const NAME = "base-v1";
// INSTALLED_VIA_CDP in extensions/common/extension.h: Chrome deletes such an entry at the next profile load.
const INSTALLED_VIA_CDP = 1 << 15;
const SCRIPTS = fileURLToPath(new URL("../../scripts/poc-cross-profile/", import.meta.url));
const POLICY_REASON =
  "ExtensionInstallForcelist needs a packed CRX behind an update manifest and a mandatory policy: on Linux /etc/opt/chrome/policies/managed belongs to root, and on macOS a user-level plist value is only recommended while ExtensionManagement reads the force list only when it is managed (extension_management.cc l=724 and l=994); the poc-d0 build is unpacked, and the POC builds no CRX server (decision 4).";

interface Ran {
  code: number;
  out: Record<string, string>;
  err: string;
  ms: number;
}

/** One script run with separate arguments; a non-zero exit is a result. */
function script(name: string, args: string[], env: NodeJS.ProcessEnv): Promise<Ran> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      "sh",
      [join(SCRIPTS, name), ...args],
      { env, encoding: "utf8" },
      (error, stdout, stderr) => {
        const out: Record<string, string> = {};
        for (const line of stdout.split("\n")) {
          const at = line.indexOf("=");
          if (at > 0) out[line.slice(0, at)] = line.slice(at + 1);
        }
        const code = error ? ((error as { code?: number }).code ?? 1) : 0;
        resolve({ code, out, err: stderr.trim().slice(-600), ms: Date.now() - started });
      },
    );
  });
}

/** The command line of a live pid, empty when it is gone (Linux /proc). */
const commandLine = (pid: string) =>
  readFile(`/proc/${pid}/cmdline`, "utf8").then(
    (line) => line.split("\0").join(" "),
    () => "",
  );

/** Pids whose command line names `root` as the user data directory. */
async function chromesOf(root: string): Promise<number[]> {
  const pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  const lines = await Promise.all(pids.map(async (pid) => [pid, await commandLine(pid)] as const));
  return lines
    .filter(([, line]) => line.includes(`--user-data-dir=${root} `))
    .map(([pid]) => Number(pid));
}

/** google-chrome first on PATH: the image's Chrome, unsandboxed as root in the container, argv[0] kept. */
async function chromeOnPath(dir: string): Promise<string> {
  const bin = join(dir, "bin");
  await mkdir(bin);
  let chrome = realpathSync(resolveChromePath());
  if (basename(chrome) === "google-chrome") chrome = join(dirname(chrome), "chrome");
  const sandbox = process.env.RECNRUN_TEST_CONTAINER === "1" ? " --no-sandbox" : "";
  const body = `#!/bin/bash\nexec -a "$0" "${chrome}"${sandbox} "$@" 2>>"${dir}/chrome.log"\n`;
  for (const name of ["google-chrome-stable", "google-chrome"]) {
    await writeFile(join(bin, name), body, { mode: 0o755 });
    await chmod(join(bin, name), 0o755);
  }
  return bin;
}

/** A base root as base.sh create-base writes it: Default/Preferences pins its Downloads root, nothing else. */
async function cleanBase(dir: string) {
  const bases = join(dir, "bases");
  const root = join(bases, NAME);
  await mkdir(join(root, "Default"), { recursive: true });
  const pin = `{"download":{"default_directory":"${root}/downloads","directory_upgrade":true,"prompt_for_download":false}}`;
  await writeFile(join(root, "Default/Preferences"), pin);
  const home = join(dir, "home");
  await mkdir(home);
  const env = {
    PATH: [await chromeOnPath(dir), process.env.PATH].join(delimiter),
    HOME: home,
    DISPLAY: process.env.DISPLAY ?? "",
    XAUTHORITY: process.env.XAUTHORITY ?? join(homedir(), ".Xauthority"),
    RECNRUN_OPEN_TIMEOUT_S: "60",
  };
  return { bases, root, env };
}

interface Extensions {
  settings?: Record<string, Record<string, unknown>>;
  ui?: { developer_mode?: boolean };
}

/** The settings entry of poc-d0 in the base, read only: location, path, and creation flags. */
async function settingsEntry(root: string) {
  for (const file of ["Secure Preferences", "Preferences"]) {
    const text = await readFile(join(root, "Default", file), "utf8").catch(() => "{}");
    const extensions = (JSON.parse(text) as { extensions?: Extensions }).extensions;
    const entry = extensions?.settings?.[POC_EXTENSION_ID];
    if (entry) {
      const { location, path, creation_flags: flags, disable_reasons: disabled } = entry;
      return {
        file,
        location,
        path,
        flags,
        disabled,
        developerMode: extensions.ui?.developer_mode,
      };
    }
  }
  return undefined;
}

/** A sample from named checks: it passes when none failed, and names each that did. */
function sampleOf(checks: Record<string, boolean>, observation: Record<string, unknown>): Sample {
  const failed = Object.entries(checks).flatMap(([name, ok]) => (ok ? [] : [name]));
  const base = { observation: { ...observation, checks } };
  return failed.length === 0
    ? { ok: true, ...base }
    : { ok: false, error: failed.join(", "), ...base };
}

/** One template start with no debugging flag, its ack, and the quit after it. */
async function relaunch(bases: string, root: string, env: NodeJS.ProcessEnv): Promise<Sample> {
  const started = await script("base.sh", ["template", bases, NAME, NAMESPACE], env);
  const pid = /pid=(\d+)/.exec(started.err)?.[1] ?? "0";
  const flags = await commandLine(pid);
  const quit = await script("base.sh", ["quit", bases, NAME], env);
  const after = await settingsEntry(root);
  const downloads = await readdir(join(root, "downloads"), { recursive: true }).catch(() => []);
  return sampleOf(
    {
      acked: started.code === 0 && /^[0-9a-f-]{36}$/.test(started.out.token ?? ""),
      downloadsInsideBase: started.out.root === `${root}/downloads`,
      noDebuggingFlag: !/remote-debugging|unsafe-extension-debugging/.test(flags),
      quit: quit.code === 0,
    },
    { template: started, quit: { code: quit.code, err: quit.err }, after, downloads },
  );
}

/** One chain on a fresh base: install, two relaunches with no client, then the freeze. */
async function chain(): Promise<Record<(typeof CELLS)[number], Sample>> {
  const dir = await mkdtemp(join(tmpdir(), "recnrun-e10-"));
  const { bases, root, env } = await cleanBase(dir);
  try {
    const build = extensionPath("poc-d0");
    const before = await settingsEntry(root);
    const installed = await script(
      "install.sh",
      ["install-base", bases, NAME, NAMESPACE, build],
      env,
    );
    const entry = await settingsEntry(root);
    const left = await chromesOf(root);
    const load = sampleOf(
      {
        noExtensionBefore: before === undefined,
        exitZero: installed.code === 0,
        pinnedId: installed.out.extensionId === POC_EXTENSION_ID,
        unpackedFromBuild: entry?.location === 4 && entry.path === build,
        cdpFlagDropped: typeof entry?.flags === "number" && (entry.flags & INSTALLED_VIA_CDP) === 0,
        chromeClosed: left.length === 0,
      },
      { install: installed, entry, left },
    );
    const first = await relaunch(bases, root, env);
    const second = await relaunch(bases, root, env);
    const frozen = await script(
      "base.sh",
      ["freeze", bases, NAME, NAMESPACE, POC_EXTENSION_ID],
      env,
    );
    const marker = await readFile(join(root, ".recnrun-base"), "utf8").catch(() => "");
    const keeps =
      second.ok &&
      frozen.code === 0 &&
      marker.includes(`install=unpacked\nunpackedPath=${build}\n`);
    const persisted = keeps ? second : { ...second, ok: false, error: second.error ?? "freeze" };
    persisted.observation = {
      ...second.observation,
      freeze: { code: frozen.code, err: frozen.err, marker },
    };
    return {
      "E10.pipe.load": load,
      "E10.pipe.persistFirstRelaunch": first,
      "E10.pipe.persistSecondRelaunch": persisted,
      "E10.policy.forcelist": { ok: false, observation: {} },
    };
  } finally {
    for (const pid of await chromesOf(root)) process.kill(pid, "SIGKILL");
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const cellOf = async (hypothesis: string, persistence: boolean): Promise<Cell> => ({
  experiment: EXPERIMENT,
  hypothesis,
  chrome: await labEnvironment.target.chrome(),
  environment: "lab",
  install: "loadUnpacked",
  label: "diagnostic",
  externalClient: !persistence,
  variant: "poc-d0",
  topology: persistence
    ? "a clean base started by base.sh template with no debugging flag after install.sh closed it"
    : "a clean base started by install.sh on the DevTools pipe",
  debugger: "none",
});

test("E10: install.sh installs poc-d0 in a base over the pipe, and the base keeps it with no client", async () => {
  test.setTimeout(900_000);
  expect(POC_EXTENSION_ID).toBe((await readFile(join(SCRIPTS, "extension-id"), "utf8")).trim());
  const chains = [];
  for (let index = sized(3); index > 0; index--) chains.push(await chain());
  for (const [index, hypothesis] of CELLS.slice(0, 3).entries()) {
    const taken = chains.map((sample) => sample[hypothesis]);
    await recordHypothesis(
      await cellOf(hypothesis, index > 0),
      async () => taken.shift() as Sample,
    );
  }
  const policy: Cell = {
    ...(await cellOf("E10.policy.forcelist", true)),
    install: "managed-policy",
    label: "strict",
    topology: "a clean base with poc-d0 named in ExtensionInstallForcelist",
  };
  await recordUnavailable(policy, POLICY_REASON);
  await expectEveryHypothesis(EXPERIMENT, CELLS);
});
