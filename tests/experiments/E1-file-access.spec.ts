import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { resolveChromePath, test } from "../browser/fixtures/chrome.ts";
import { extensionPath, loadUnpacked } from "../browser/fixtures/extension-loaders.ts";
import {
  installedState,
  launchStrict,
  preparePolicyInstall,
} from "../browser/fixtures/policy-install.ts";
import { windowShows } from "../browser/fixtures/x-display.ts";
import {
  defaultSample,
  noHostPermissionSample,
  noDeveloperModeSample,
  observe,
  reinstallSample,
  runsAfterRelaunch,
  toggleSample,
} from "./e1-samples.ts";
import type { E1Cells } from "./e1-samples.ts";
import { fileAccessPref, requireBuild } from "./file-access.ts";
import { expectEveryHypothesis, recordHypothesis, recordUnavailable } from "./outcome.ts";
import type { Cell, Sample } from "./outcome.ts";

/*
 * E1 (POC PLAN.md P1.2) in the lab: the file-scheme state of the poc-d0 build after each install
 * method, and the "Allow access to file URLs" toggle clicked on the display with xdotool.
 */

const EXPERIMENT = "E1";
const HYPOTHESES = [
  "E1.unpacked.default",
  "E1.unpacked.toggleOff",
  "E1.unpacked.toggleOn",
  "E1.unpacked.reinstall",
  "E1.unpacked.noHostPermission",
  "E1.unpacked.noDeveloperMode",
  "E1.policy.default",
  "E1.packed",
];
const VARIANT = "poc-d0";
const PATH = extensionPath(VARIANT);
// No window manager: the window sits where it asks, so page coordinates map onto the display.
const WINDOW = ["--window-position=0,0", "--window-size=1280,1000"];
const INSTALL_TIMEOUT_MS = 60_000;
const DASHBOARD_TIMEOUT_MS = 15_000;
const POLL_MS = 500;
const DASHBOARD_WINDOW = "^RECnRun - Google Chrome$";
const NO_CHANNEL = "no observation channel without CDP until E2 writes results to disk";

type Common = Pick<Cell, "install" | "label" | "externalClient">;

async function chromeVersion(): Promise<string> {
  return (await promisify(execFile)(resolveChromePath(), ["--version"])).stdout.trim();
}

async function cell(hypothesis: string, common: Common): Promise<Cell> {
  const chrome = await chromeVersion();
  const fixed = { variant: VARIANT, topology: "single-root", debugger: "none" } as const;
  return { experiment: EXPERIMENT, hypothesis, chrome, environment: "lab", ...common, ...fixed };
}

const labCells: E1Cells = {
  build: PATH,
  methods: ["xdotool", "cdp-click", "element-click"],
  fresh: async (build) => {
    const root = await mkdtemp(join(tmpdir(), "recnrun-e1-"));
    const install = async () =>
      observe(await loadUnpacked(build, { userDataDir: root, args: WINDOW }));
    try {
      const first = await install();
      const dispose = () =>
        rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      const relaunch = (id: string) => runsAfterRelaunch({ userDataDir: root, args: WINDOW }, id);
      return { root, first, reinstall: install, relaunch, dispose };
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  },
};

/** Waits for the policy install's unpacked folder, which Chrome writes with no client attached. */
async function waitOnDisk(root: string, id: string): Promise<boolean> {
  const deadline = Date.now() + INSTALL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await installedState(root, id)).onDisk) return true;
    await delay(POLL_MS);
  }
  return false;
}

/** Force-installs by policy with no CDP client, quits with SIGTERM, and reads the root's prefs. */
async function policySample(): Promise<Sample> {
  const install = await preparePolicyInstall(PATH);
  const root = await mkdtemp(join(tmpdir(), "recnrun-e1-policy-"));
  try {
    await install.writePolicy();
    const chrome = await launchStrict(root);
    let installed = false;
    let ran = false;
    try {
      installed = await waitOnDisk(root, install.id);
      ran = installed && (await windowShows(DASHBOARD_WINDOW, DASHBOARD_TIMEOUT_MS));
    } finally {
      await chrome.close();
    }
    const state = await installedState(root, install.id);
    const pref = await fileAccessPref(root, install.id);
    const fetch = { unavailable: NO_CHANNEL };
    const observation = {
      extensionId: install.id,
      installed,
      ran,
      state,
      pref,
      fetch,
      gestures: 0,
    };
    const problems: string[] = [];
    if (!state.onDisk || state.location === undefined) problems.push("not installed in the root");
    if (pref.newAllowFileAccess === true) problems.push(`newAllowFileAccess true in ${pref.file}`);
    if (problems.length === 0) return { ok: true, observation, steps: [] };
    return { ok: false, error: problems.join("; "), observation, steps: [] };
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await install.cleanup();
  }
}

test.describe("E1: file-scheme state of the poc-d0 build in Google Chrome Stable", () => {
  const unpacked: Common = { install: "loadUnpacked", label: "diagnostic", externalClient: true };

  test.beforeAll(async () => {
    await requireBuild(PATH, VARIANT);
  });

  test("E1.unpacked.default: no file access after loadUnpacked with no gesture", async () => {
    await recordHypothesis(await cell("E1.unpacked.default", unpacked), () =>
      defaultSample(labCells),
    );
  });

  test("E1.unpacked.toggleOff: the toggle turned off breaks the file:// read", async () => {
    await recordHypothesis(await cell("E1.unpacked.toggleOff", unpacked), () =>
      toggleSample(labCells, false),
    );
  });

  test("E1.unpacked.toggleOn: the toggle turned on lets the extension read the probe", async () => {
    await recordHypothesis(await cell("E1.unpacked.toggleOn", unpacked), () =>
      toggleSample(labCells, true),
    );
  });

  test("E1.unpacked.reinstall: a revoke does not survive a relaunch and a reinstall", async () => {
    await recordHypothesis(await cell("E1.unpacked.reinstall", unpacked), () =>
      reinstallSample(labCells),
    );
  });

  test("E1.unpacked.noHostPermission: without file:///* the read fails although access is on", async () => {
    await recordHypothesis(await cell("E1.unpacked.noHostPermission", unpacked), () =>
      noHostPermissionSample(labCells),
    );
  });

  test("E1.unpacked.noDeveloperMode: without Developer mode the toggle disables the build", async () => {
    await recordHypothesis(await cell("E1.unpacked.noDeveloperMode", unpacked), () =>
      noDeveloperModeSample(labCells),
    );
  });

  test("E1.policy.default: a policy install starts without file access", async () => {
    const strict: Common = { install: "managed-policy", label: "strict", externalClient: false };
    await recordHypothesis(await cell("E1.policy.default", strict), policySample);
  });

  test("E1.packed: not executed in this round", async () => {
    const none: Common = { install: "none", label: "strict", externalClient: false };
    const reason = "packed distribution not executed in this round (decision 4, M-P9.c)";
    await recordUnavailable(await cell("E1.packed", none), reason);
  });

  test("every E1 hypothesis left a verdict", async () => {
    await expectEveryHypothesis(EXPERIMENT, HYPOTHESES);
  });
});
