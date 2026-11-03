import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, resolveChromePath, test } from "../browser/fixtures/chrome.ts";
import {
  attachExtension,
  EXTENSION_PATH,
  launchForUnpacked,
  loadUnpacked,
} from "../browser/fixtures/extension-loaders.ts";
import {
  installedState,
  launchStrict,
  preparePolicyInstall,
  UnavailableError,
} from "../browser/fixtures/policy-install.ts";
import type { InstalledState } from "../browser/fixtures/policy-install.ts";
import { windowShows } from "../browser/fixtures/x-display.ts";
import { observePersistence, persistenceProblems } from "./relaunch.ts";
import type { RelaunchSteps } from "./relaunch.ts";
import { sized } from "./samples.ts";
import { appendVerdict, readVerdicts } from "./verdicts.ts";
import type { Verdict } from "./verdicts.ts";

/*
 * E0 (POC PLAN.md P0.3): both lab install methods on this base and this Chrome. A failed
 * hypothesis is a verdict; the last test fails only when a hypothesis left none.
 */

const EXPERIMENT = "E0";
const HYPOTHESES = ["E0.loadUnpacked", "E0.loadUnpacked.persists", "E0.managedPolicy"];
// The dashboard RECnRun opens and focuses on install and on startup (src/background/start.ts).
const DASHBOARD_WINDOW = "^RECnRun - Google Chrome$";
const INSTALL_TIMEOUT_MS = 60_000;
const STARTUP_TIMEOUT_MS = 30_000;
const DEBUGGING_FLAG = /^--remote-debugging-/;

interface Sample {
  ok: boolean;
  error?: string;
  observation: Record<string, unknown>;
}

type Common = Pick<Verdict, "install" | "label" | "externalClient">;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function chromeVersion(): Promise<string> {
  const run = promisify(execFile);
  return (await run(resolveChromePath(), ["--version"])).stdout.trim();
}

async function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "recnrun-e0-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** Installs over CDP and pings the worker, which must answer with its own id. */
const unpackedSample = (path: string): Promise<Sample> =>
  withRoot(async (root) => {
    const loaded = await loadUnpacked(path, { userDataDir: root });
    await loaded.close();
    const { extensionId } = loaded;
    const observation = { extensionId, stateAfterQuit: await installedState(root, extensionId) };
    return { ok: true, observation };
  });

/** The same root relaunched with the install's flags, observed before anything installs it again. */
function relaunchSteps(root: string, path: string, extensionId: string): RelaunchSteps {
  return {
    relaunch: async () => {
      const chrome = await launchForUnpacked({ userDataDir: root });
      const running = () =>
        attachExtension(chrome, extensionId).then(
          () => true,
          () => false,
        );
      const dashboard = () => windowShows(DASHBOARD_WINDOW, STARTUP_TIMEOUT_MS / 3);
      return { dashboard, running, quit: () => chrome.close() };
    },
    state: () => installedState(root, extensionId),
    reinstall: async () => {
      const again = await loadUnpacked(path, { userDataDir: root });
      await again.close();
      return again.extensionId;
    },
  };
}

/** Installs over CDP, quits, relaunches the same root with the same flags, and checks it still runs. */
const persistsSample = (path: string): Promise<Sample> =>
  withRoot(async (root) => {
    const first = await loadUnpacked(path, { userDataDir: root });
    await first.close();
    const { extensionId } = first;
    const stateAfterQuit = await installedState(root, extensionId);
    const observed = await observePersistence(relaunchSteps(root, path, extensionId));
    const observation = { extensionId, stateAfterQuit, ...observed };
    const problems = persistenceProblems(observed);
    if (problems.length === 0) return { ok: true, observation };
    return { ok: false, error: problems.join("; "), observation };
  });

const disabled = ({ disableReasons }: InstalledState) =>
  Array.isArray(disableReasons) ? disableReasons.length > 0 : Boolean(disableReasons);

/** One launch with no CDP client: did the extension open its dashboard, and what did the root keep? */
async function strictLaunch(root: string, id: string, ms: number) {
  const chrome = await launchStrict(root);
  let ran = false;
  try {
    ran = await windowShows(DASHBOARD_WINDOW, ms);
    if (chrome.exited()) throw new Error(`Chrome exited:\n${chrome.diagnostics()}`);
  } finally {
    await chrome.close();
  }
  const debuggingFlags = chrome.flags.filter((flag) => DEBUGGING_FLAG.test(flag));
  return { ran, debuggingFlags, state: await installedState(root, id) };
}

/** Force-installs by policy, observes the first launch, quits, relaunches, and observes again. */
async function policySample(path: string): Promise<Sample> {
  const install = await preparePolicyInstall(path);
  try {
    await install.writePolicy();
    return await withRoot(async (root) => {
      const first = await strictLaunch(root, install.id, INSTALL_TIMEOUT_MS);
      const relaunch = await strictLaunch(root, install.id, STARTUP_TIMEOUT_MS);
      const requests = [...install.requests];
      const observation = { extensionId: install.id, first, relaunch, requests };
      const failures = [first, relaunch].flatMap((launch, index) => {
        const when = index === 0 ? "after the install" : "after the relaunch";
        const problems: string[] = [];
        if (launch.debuggingFlags.length > 0) problems.push(`debugging flags ${when}`);
        if (!launch.ran) problems.push(`no RECnRun dashboard window ${when}`);
        if (!launch.state.onDisk || launch.state.location === undefined)
          problems.push(`not in the root ${when}`);
        if (disabled(launch.state)) problems.push(`disabled ${when}`);
        return problems;
      });
      if (failures.length === 0) return { ok: true, observation };
      return { ok: false, error: failures.join("; "), observation };
    });
  } finally {
    await install.cleanup();
  }
}

async function takeSamples(take: () => Promise<Sample>) {
  const samples: Sample[] = [];
  for (let index = sized(3); index > 0; index--) {
    try {
      samples.push(await take());
    } catch (error) {
      if (error instanceof UnavailableError) return { samples, unavailable: error.message };
      samples.push({ ok: false, error: message(error), observation: {} });
    }
  }
  return { samples, unavailable: undefined };
}

// Distributes over the verdict variants, so each keeps its own error and sample rules.
type Outcome<V extends Verdict = Verdict> = V extends unknown
  ? Pick<V, "verdict" | "error" | "samples">
  : never;

/** `unavailable` only when the method could not run at all; it names the reason with no sample. */
function outcome(samples: Sample[], unavailable: string | undefined): Outcome {
  if (unavailable && samples.length === 0) {
    return { verdict: "unavailable", error: unavailable, samples: 0 };
  }
  const errors = samples.flatMap((sample) => (sample.error ? [sample.error] : []));
  const passed = samples.length > 0 && samples.every((sample) => sample.ok);
  const error = unavailable ?? (errors.length > 0 ? errors.join(" | ") : undefined);
  const verdict = passed ? "pass" : "fail";
  return { verdict, ...(error === undefined ? {} : { error }), samples: samples.length };
}

async function record(hypothesis: string, common: Common, take: () => Promise<Sample>) {
  const { samples, unavailable } = await takeSamples(take);
  const verdict: Verdict = {
    experiment: EXPERIMENT,
    hypothesis,
    ...outcome(samples, unavailable),
    chrome: await chromeVersion(),
    environment: "lab",
    ...common,
    variant: "test",
    topology: "single-root",
    debugger: "none",
    observations: samples.map((sample) => sample.observation),
  };
  await appendVerdict(verdict);
  console.log(JSON.stringify(verdict));
}

test.describe("E0: install the test build into Google Chrome Stable", () => {
  const unpacked: Common = { install: "loadUnpacked", label: "diagnostic", externalClient: true };

  test("E0.loadUnpacked: installs over CDP and the worker answers", async () => {
    await record("E0.loadUnpacked", unpacked, () => unpackedSample(EXTENSION_PATH));
  });

  test("E0.loadUnpacked.persists: still installed and running after a quit and relaunch", async () => {
    await record("E0.loadUnpacked.persists", unpacked, () => persistsSample(EXTENSION_PATH));
  });

  test("E0.managedPolicy: force-installs with no CDP client and stays installed after a relaunch", async () => {
    const common: Common = { install: "managed-policy", label: "strict", externalClient: false };
    await record("E0.managedPolicy", common, () => policySample(EXTENSION_PATH));
  });

  test("every E0 hypothesis left a verdict", async () => {
    const verdicts = (await readVerdicts()).filter((entry) => entry.experiment === EXPERIMENT);
    const latest = new Map(verdicts.map((entry) => [entry.hypothesis, entry]));
    expect([...latest.keys()].sort(), "every hypothesis ran").toEqual(HYPOTHESES);
    for (const verdict of latest.values()) {
      const sampled = verdict.samples > 0 || (verdict.verdict === "unavailable" && verdict.error);
      expect(sampled, `${verdict.hypothesis} took no sample`).toBeTruthy();
    }
  });
});
