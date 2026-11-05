import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "./fixtures/host-chrome.ts";
import { evidence, hostRunId, requireHost } from "./fixtures/host-env.ts";
import { hostEnvironment } from "./fixtures/e4-host.ts";
import {
  chromesOf,
  commandLineOf,
  keychainProblems,
  launcherEnv,
} from "./fixtures/launcher-host.ts";
import { extensionPath } from "../browser/fixtures/extension-loaders.ts";
import { POC_EXTENSION_ID, requireBuild } from "../experiments/file-access.ts";
import { labelPaths } from "../experiments/host-paths.ts";
import type { PathLabel } from "../experiments/host-paths.ts";
import {
  expectEveryHypothesis,
  recordHypothesis,
  recordUnavailable,
} from "../experiments/outcome.ts";
import type { Cell, Sample } from "../experiments/outcome.ts";

/*
 * E10's host twin (POC PLAN.md P6.2, CL17) on the installed Google Chrome of this Mac:
 * install.sh installs the poc-d0 build in a clean base below RECNRUN_HOST_BASES over the DevTools
 * pipe, then base.sh template starts the base twice with no debugging flag, and base.sh freeze
 * records the unpacked build. Chrome is launcherEnv's wrapper (--use-mock-keychain); the base and
 * its folder are removed at the end. The policy cell reads whether the managed plist exists and
 * writes nothing.
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
const INSTALLED_VIA_CDP = 1 << 15;
const SCRIPTS = fileURLToPath(new URL("../../scripts/poc-cross-profile/", import.meta.url));
const MANAGED_PLIST = "/Library/Managed Preferences/com.google.Chrome.plist";
const POLICY_REASON =
  "ExtensionInstallForcelist needs a packed CRX behind an update manifest and a mandatory policy: on macOS only a managed plist (an MDM profile) is mandatory, a user-level value is only recommended (policy_loader_mac.cc l=126), and ExtensionManagement reads the force list only when it is managed (extension_management.cc l=724 and l=994); the poc-d0 build is unpacked, and the POC builds no CRX server (decision 4).";
const labels: PathLabel[] = [];

interface Ran {
  code: number;
  out: Record<string, string>;
  err: string;
}

function script(name: string, args: string[], env: NodeJS.ProcessEnv): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(
      "sh",
      [join(SCRIPTS, name), ...args],
      { env, encoding: "utf8" },
      (error, stdout, stderr) => {
        const out = Object.fromEntries(
          stdout.split("\n").flatMap((line) => {
            const at = line.indexOf("=");
            return at > 0 ? [[line.slice(0, at), line.slice(at + 1)]] : [];
          }),
        );
        const code = error ? ((error as { code?: number }).code ?? 1) : 0;
        resolve({ code, out, err: stderr.trim().slice(-600) });
      },
    );
  });
}

/** The settings entry of poc-d0 in the base, read only. */
async function settingsEntry(root: string) {
  for (const file of ["Secure Preferences", "Preferences"]) {
    const text = await readFile(join(root, "Default", file), "utf8").catch(() => "{}");
    const extensions = (
      JSON.parse(text) as { extensions?: { settings?: Record<string, Record<string, unknown>> } }
    ).extensions;
    const entry = extensions?.settings?.[POC_EXTENSION_ID];
    if (entry)
      return { file, location: entry.location, path: entry.path, flags: entry.creation_flags };
  }
  return undefined;
}

function sampleOf(checks: Record<string, boolean>, observation: Record<string, unknown>): Sample {
  const failed = Object.entries(checks).flatMap(([name, ok]) => (ok ? [] : [name]));
  const base = { observation: labelPaths({ ...observation, checks }, labels) };
  return failed.length === 0
    ? { ok: true, ...base }
    : { ok: false, error: failed.join(", "), ...base };
}

async function relaunch(
  bases: string,
  root: string,
  env: NodeJS.ProcessEnv,
  home: string,
): Promise<Sample> {
  const started = await script("base.sh", ["template", bases, NAME, NAMESPACE], env);
  const flags = await commandLineOf(Number(/pid=(\d+)/.exec(started.err)?.[1] ?? "0"));
  const quit = await script("base.sh", ["quit", bases, NAME], env);
  return sampleOf(
    {
      acked: started.code === 0 && /^[0-9a-f-]{36}$/.test(started.out.token ?? ""),
      downloadsInsideBase: started.out.root === `${root}/downloads`,
      noDebuggingFlag: !/remote-debugging|unsafe-extension-debugging/.test(flags),
      mockKeychain: keychainProblems(flags, home).length === 0,
      quit: quit.code === 0,
    },
    {
      template: started,
      quit: { code: quit.code, err: quit.err },
      after: await settingsEntry(root),
    },
  );
}

/** A clean base as create-base leaves it, with no Chrome started: Default/Preferences pins its Downloads root. */
async function cleanBase() {
  const parent =
    process.env.RECNRUN_HOST_BASES ?? join(homedir(), "Documents/RECnRun/poc-downloads-launcher");
  const bases = join(parent, `bases-e10-${hostRunId()}`);
  const root = join(bases, NAME);
  await mkdir(join(root, "Default"), { recursive: true });
  const pin = `{"download":{"default_directory":"${root}/downloads","directory_upgrade":true,"prompt_for_download":false}}`;
  await writeFile(join(root, "Default/Preferences"), pin);
  const home = join(bases, "home");
  await mkdir(home);
  labels.push([home, "<home>"], [root, "<root>"], [bases, "<bases>"]);
  return { bases, root, home, env: { ...(await launcherEnv(home)), RECNRUN_OPEN_TIMEOUT_S: "60" } };
}

async function chain(): Promise<Record<(typeof CELLS)[number], Sample>> {
  const { bases, root, home, env } = await cleanBase();
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
    const first = await relaunch(bases, root, env, home);
    const second = await relaunch(bases, root, env, home);
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
    persisted.observation = labelPaths(
      { ...second.observation, freeze: { code: frozen.code, err: frozen.err, marker } },
      labels,
    );
    return {
      "E10.pipe.load": load,
      "E10.pipe.persistFirstRelaunch": first,
      "E10.pipe.persistSecondRelaunch": persisted,
      "E10.policy.forcelist": { ok: false, observation: {} },
    };
  } finally {
    for (const pid of await chromesOf(root)) process.kill(pid, "SIGKILL");
    await rm(bases, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const cellOf = async (hypothesis: string, persistence: boolean): Promise<Cell> => ({
  experiment: EXPERIMENT,
  hypothesis,
  chrome: await hostEnvironment.target.chrome(),
  environment: "host",
  install: "loadUnpacked",
  label: "diagnostic",
  externalClient: !persistence,
  variant: "poc-d0",
  topology: persistence
    ? "a clean base started by base.sh template with no debugging flag after install.sh closed it"
    : "a clean base started by install.sh on the DevTools pipe",
  debugger: "none",
});

test.describe("E10 on the host: install.sh installs poc-d0 in a base, and the base keeps it", () => {
  test.describe.configure({ timeout: 900_000 });

  test.beforeAll(async () => {
    requireHost();
    await requireBuild(extensionPath("poc-d0"), "poc-d0");
  });

  test("E10.pipe: install over the pipe, two relaunches with no client, and the freeze", async () => {
    const taken = await chain();
    const directory = evidence().directory;
    for (const [index, hypothesis] of CELLS.slice(0, 3).entries()) {
      await recordHypothesis(await cellOf(hypothesis, index > 0), async () => taken[hypothesis], {
        full: 1,
        directory,
      });
    }
  });

  test("E10.policy.forcelist: unavailable, the managed plist only read", async () => {
    const managed = await access(MANAGED_PLIST).then(
      () => "present",
      () => "absent",
    );
    const cell: Cell = {
      ...(await cellOf("E10.policy.forcelist", true)),
      install: "managed-policy",
      label: "strict",
      topology: `a clean base with poc-d0 named in ExtensionInstallForcelist; ${MANAGED_PLIST} is ${managed}`,
    };
    await recordUnavailable(cell, POLICY_REASON, evidence().directory);
  });

  test("every E10 hypothesis left a verdict", async () => {
    await expectEveryHypothesis(EXPERIMENT, CELLS, evidence().directory);
  });
});
