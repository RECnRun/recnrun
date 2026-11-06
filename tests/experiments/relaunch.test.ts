import { describe, expect, test } from "vite-plus/test";
import type { InstalledState } from "../browser/fixtures/policy-install.ts";
import { observePersistence, persistenceProblems } from "./relaunch.ts";
import type { RelaunchSteps } from "./relaunch.ts";

const ID = "aohedjlnhghpahbgpcccgplhbidpfdeh";
const purged: InstalledState = { onDisk: false };
const reinstalled: InstalledState = { onDisk: false, location: 4, disableReasons: [] };

/** A root whose relaunch purged the CDP install; a reinstall writes a new prefs entry. */
function fakeSteps(running: boolean) {
  const calls: string[] = [];
  let installedAgain = false;
  const steps: RelaunchSteps = {
    relaunch: () => {
      calls.push("relaunch");
      return Promise.resolve({
        dashboard: () => (calls.push("dashboard"), Promise.resolve(running)),
        running: () => (calls.push("running"), Promise.resolve(running)),
        quit: () => (calls.push("quit"), Promise.resolve()),
      });
    },
    state: () => (calls.push("state"), Promise.resolve(installedAgain ? reinstalled : purged)),
    reinstall: () => {
      calls.push("reinstall");
      installedAgain = true;
      return Promise.resolve(ID);
    },
  };
  return { steps, calls };
}

describe("observePersistence", () => {
  test("records the state the relaunch left, read before any reinstall", async () => {
    const { steps, calls } = fakeSteps(false);
    const observed = await observePersistence(steps);
    expect(observed.stateAfterRelaunch).toEqual(purged);
    expect(calls).toEqual(["relaunch", "dashboard", "running", "quit", "state", "reinstall"]);
    expect(observed).toMatchObject({ runningAfterRelaunch: false, idAfterReinstall: ID });
  });

  test("does not reinstall a build that is still running", async () => {
    const { steps, calls } = fakeSteps(true);
    const observed = await observePersistence(steps);
    expect(calls).not.toContain("reinstall");
    expect(observed).toMatchObject({ runningAfterRelaunch: true, dashboardAfterRelaunch: true });
  });

  test("fails a relaunch that purged the build and passes one that kept it running", async () => {
    const failed = persistenceProblems(await observePersistence(fakeSteps(false).steps));
    expect(failed).toEqual([
      "the worker did not answer after the relaunch",
      "no RECnRun dashboard window after the relaunch",
      "no prefs entry after the relaunch",
    ]);
    const kept = { dashboardAfterRelaunch: true, runningAfterRelaunch: true };
    expect(persistenceProblems({ ...kept, stateAfterRelaunch: reinstalled })).toEqual([]);
    const disabled = { ...reinstalled, disableReasons: [1] };
    expect(persistenceProblems({ ...kept, stateAfterRelaunch: disabled })).toEqual([
      "disabled after the relaunch",
    ]);
  });
});
