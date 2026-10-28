import { IdentityDataSchema } from "@recnrun/domain";
import * as v from "valibot";
import type { BootstrapHooks, BootstrapStep, StepTiming } from "@/background/workspace/bootstrap";
import type { WorkspaceCommands } from "@/background/workspace/commands";
import { WorkspaceError } from "@/background/workspace/errors";

/** What end-to-end tests reach on the test build's service worker, as `recnrunPoc`. */
export interface PocHandles {
  startWithIdentity: (url: string, data: unknown) => Promise<StepTiming[]>;
  /** Holds the restore payload back this long, with the page already behind the barrier. */
  setRestoreDelay: (ms: number) => void;
  /** Fails the next run of `step` once, before it starts. */
  failNext: (step: BootstrapStep) => void;
  timings: () => StepTiming[][];
}

/**
 * Installs the POC's test handles on `scope` and drives `hooks`. Only test builds call this, so a
 * published bundle never contains it.
 */
export function installTestHandles(
  scope: object,
  commands: WorkspaceCommands,
  hooks: BootstrapHooks,
): void {
  let restoreDelayMs = 0;
  let failing: BootstrapStep | undefined;
  const runs: StepTiming[][] = [];
  hooks.beforeStep = async (step) => {
    if (step === failing) {
      failing = undefined;
      throw new WorkspaceError("InjectedFailure", `The test build failed the ${step} step.`);
    }
    if (step === "restore" && restoreDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, restoreDelayMs));
    }
  };
  const handles: PocHandles = {
    startWithIdentity: async (url, data) => {
      const timings = await commands.startWithIdentity(url, v.parse(IdentityDataSchema, data));
      runs.push(timings);
      return timings;
    },
    setRestoreDelay: (ms) => {
      restoreDelayMs = ms;
    },
    failNext: (step) => {
      failing = step;
    },
    timings: () => runs,
  };
  Object.assign(scope, { recnrunPoc: handles });
}
