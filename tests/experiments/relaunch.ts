import type { InstalledState } from "../browser/fixtures/policy-install.ts";

/** One relaunch of a root the build was installed into; the spec passes Chrome, the tests a fake. */
export interface RelaunchSteps {
  /** Starts Chrome on the same root with the same flags, installing nothing. */
  relaunch(): Promise<Relaunched>;
  /** The root's install state as its files record it once Chrome quit. */
  state(): Promise<InstalledState>;
  /** Installs the build again into a fresh launch of the root and returns the id it got. */
  reinstall(): Promise<string>;
}

interface Relaunched {
  /** Whether the extension opened its dashboard at startup on its own. */
  dashboard(): Promise<boolean>;
  /** Whether the extension's worker answers. */
  running(): Promise<boolean>;
  quit(): Promise<void>;
}

export interface PersistenceObservation {
  dashboardAfterRelaunch: boolean;
  runningAfterRelaunch: boolean;
  stateAfterRelaunch: InstalledState;
  idAfterReinstall?: string;
}

/**
 * Relaunches the root, observes the extension with nothing installed again, quits, and reads what
 * the root kept; only then reinstalls a build that no longer runs, so the reinstall never shows up
 * as what survived.
 */
export async function observePersistence(steps: RelaunchSteps): Promise<PersistenceObservation> {
  const again = await steps.relaunch();
  let dashboardAfterRelaunch = false;
  let runningAfterRelaunch = false;
  try {
    dashboardAfterRelaunch = await again.dashboard();
    runningAfterRelaunch = await again.running();
  } finally {
    await again.quit();
  }
  const stateAfterRelaunch = await steps.state();
  if (runningAfterRelaunch)
    return { dashboardAfterRelaunch, runningAfterRelaunch, stateAfterRelaunch };
  const idAfterReinstall = await steps.reinstall();
  return { dashboardAfterRelaunch, runningAfterRelaunch, stateAfterRelaunch, idAfterReinstall };
}

/** Why a relaunch did not keep the build installed, enabled, and running; empty when it did. */
export function persistenceProblems(observed: PersistenceObservation): string[] {
  const { stateAfterRelaunch: state } = observed;
  const problems: string[] = [];
  if (!observed.runningAfterRelaunch) problems.push("the worker did not answer after the relaunch");
  if (!observed.dashboardAfterRelaunch)
    problems.push("no RECnRun dashboard window after the relaunch");
  if (state.location === undefined) problems.push("no prefs entry after the relaunch");
  const reasons = state.disableReasons;
  if (Array.isArray(reasons) ? reasons.length > 0 : Boolean(reasons))
    problems.push("disabled after the relaunch");
  return problems;
}
