import { extensionPath, loadUnpacked } from "../browser/fixtures/extension-loaders.ts";
import {
  defaultSample,
  hostPermissionSample,
  noDeveloperModeSample,
  observe,
  reinstallSample,
  runsAfterRelaunch,
  toggleSample,
} from "../experiments/e1-samples.ts";
import type { E1Cells } from "../experiments/e1-samples.ts";
import { requireBuild } from "../experiments/file-access.ts";
import {
  expectEveryHypothesis,
  recordHypothesis,
  recordUnavailable,
} from "../experiments/outcome.ts";
import type { Cell, Sample } from "../experiments/outcome.ts";
import { hostUnpackedOptions, openHostExtension, test } from "./fixtures/host-chrome.ts";
import { evidence, installedChromeVersion } from "./fixtures/host-env.ts";

/*
 * E1's host twin (POC PLAN.md P1.2): the installed Google Chrome of this Mac on throwaway roots.
 * No xdotool here, so the toggle is clicked with CDP input on chrome://extensions and labelled so.
 */

const EXPERIMENT = "E1";
const HYPOTHESES = [
  "E1.unpacked.default",
  "E1.unpacked.toggleOff",
  "E1.unpacked.toggleOn",
  "E1.unpacked.reinstall",
  "E1.unpacked.hostPermission",
  "E1.unpacked.noDeveloperMode",
  "E1.policy.default",
  "E1.packed",
  "E1.gesture.default",
];
const VARIANT = "poc-d0";
const PATH = extensionPath(VARIANT);

type Common = Pick<Cell, "install" | "label" | "externalClient">;

async function cell(hypothesis: string, common: Common): Promise<Cell> {
  const chrome = `Google Chrome ${await installedChromeVersion()}`;
  const fixed = { variant: VARIANT, topology: "single-root", debugger: "none" } as const;
  return { experiment: EXPERIMENT, hypothesis, chrome, environment: "host", ...common, ...fixed };
}

let roots = 0;

const hostCells: E1Cells = {
  build: PATH,
  methods: ["cdp-click", "element-click"],
  fresh: async (build) => {
    roots += 1;
    const host = await openHostExtension(`e1-${roots}`, { path: build });
    const options = hostUnpackedOptions(host.root);
    try {
      const first = await observe(host, () => host.quit());
      const reinstall = async () => observe(await loadUnpacked(build, options));
      const relaunch = (id: string) => runsAfterRelaunch(options, id);
      return { root: host.root, first, reinstall, relaunch, dispose: () => host.close() };
    } catch (error) {
      await host.close();
      throw error;
    }
  },
};

test.describe("E1 on the host: file-scheme state of the poc-d0 build", () => {
  test.describe.configure({ timeout: 600_000 });
  const unpacked: Common = { install: "loadUnpacked", label: "diagnostic", externalClient: true };
  const directory = () => evidence().directory;
  const record = async (hypothesis: string, take: () => Promise<Sample>) => {
    await recordHypothesis(await cell(hypothesis, unpacked), take, { directory: directory() });
  };

  test.beforeAll(async () => {
    await requireBuild(PATH, VARIANT);
  });

  test("E1.unpacked.default: no file access after loadUnpacked with no gesture", async () => {
    await record("E1.unpacked.default", () => defaultSample(hostCells));
  });

  test("E1.unpacked.toggleOff: the toggle turned off breaks the file:// read", async () => {
    await record("E1.unpacked.toggleOff", () => toggleSample(hostCells, false));
  });

  test("E1.unpacked.toggleOn: the toggle turned on lets the extension read the probe", async () => {
    await record("E1.unpacked.toggleOn", () => toggleSample(hostCells, true));
  });

  test("E1.unpacked.reinstall: a revoke does not survive a relaunch and a reinstall", async () => {
    await record("E1.unpacked.reinstall", () => reinstallSample(hostCells));
  });

  test("E1.unpacked.hostPermission: with file:///* host access the toggle alone decides the read", async () => {
    await record("E1.unpacked.hostPermission", () => hostPermissionSample(hostCells));
  });

  test("E1.unpacked.noDeveloperMode: without Developer mode the toggle disables the build", async () => {
    await record("E1.unpacked.noDeveloperMode", () => noDeveloperModeSample(hostCells));
  });

  test("E1.policy.default: unavailable on macOS", async () => {
    const strict: Common = { install: "managed-policy", label: "strict", externalClient: false };
    const reason =
      "managed policy on macOS needs a root-owned plist in /Library/Managed Preferences; the host runner writes no system file";
    await recordUnavailable(await cell("E1.policy.default", strict), reason, directory());
  });

  test("E1.packed: not executed in this round", async () => {
    const none: Common = { install: "none", label: "strict", externalClient: false };
    const reason = "packed distribution not executed in this round (decision 4, M-P9.c)";
    await recordUnavailable(await cell("E1.packed", none), reason, directory());
  });

  test("E1.gesture.default: the owner's Load unpacked is a manual item", async () => {
    const gesture: Common = {
      install: "load-unpacked-gesture",
      label: "strict",
      externalClient: false,
    };
    const reason =
      "the owner's Load unpacked and toggle in the personal Default are manual item M-P1.a, never run by an agent";
    await recordUnavailable(await cell("E1.gesture.default", gesture), reason, directory());
  });

  test("every E1 hypothesis left a verdict", async () => {
    await expectEveryHypothesis(EXPERIMENT, HYPOTHESES, directory());
  });
});
