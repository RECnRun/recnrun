import { CaptureCapabilitiesSchema, IdentityDataSchema } from "@recnrun/domain";
import * as v from "valibot";
import type { BootstrapHooks, BootstrapStep, StepTiming } from "@/background/workspace/bootstrap";
import type { CaptureSummary } from "@/background/workspace/capture";
import type { WorkspaceCommands } from "@/background/workspace/commands";
import { WorkspaceError } from "@/background/workspace/errors";

/** What end-to-end tests reach on the test build's service worker, as `recnrunPoc`. */
export interface PocHandles {
  startWithIdentity: (url: string, data: unknown) => Promise<StepTiming[]>;
  /** Captures the managed tab's page as `identityId`; the only way to capture in this POC stage. */
  captureIdentity: (identityId: string, capabilities?: unknown) => Promise<CaptureSummary>;
  /** Starts from `identityId`'s published capture, as `startWithIdentity` starts from data. */
  startFromCapture: (identityId: string) => Promise<StepTiming[]>;
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
  const kept = async (starting: Promise<StepTiming[]>) => {
    const timings = await starting;
    runs.push(timings);
    return timings;
  };
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
    // Async, so data that fails its schema rejects rather than throws.
    startWithIdentity: async (url, data) =>
      kept(commands.startWithIdentity(url, v.parse(IdentityDataSchema, data))),
    captureIdentity: async (identityId, capabilities = { cookieHosts: [] }) =>
      commands.captureIdentity(identityId, v.parse(CaptureCapabilitiesSchema, capabilities)),
    startFromCapture: (identityId) => kept(commands.startFromCapture(identityId)),
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
