import { IdentityDataSchema } from "@recnrun/domain";
import * as v from "valibot";
import type { BootstrapHooks, HookStep, StepTiming } from "@/background/workspace/bootstrap";
import { replayStaleReplies } from "@/background/stale-replies";
import type { ConnectEvent } from "@/background/stale-replies";
import type { CaptureSummary } from "@/background/workspace/capture";
import type { WorkspaceCommands } from "@/background/workspace/commands";
import { WorkspaceError } from "@/background/workspace/errors";

/** What end-to-end tests reach on the test build's service worker, as `recnrunPoc`. */
export interface PocHandles {
  startWithIdentity: (url: string, data: unknown) => Promise<StepTiming[]>;
  /** Captures the managed tab's page as `identityId`; the only way to capture in this POC stage. */
  captureIdentity: (identityId: string) => Promise<CaptureSummary>;
  /** Starts from `identityId`'s published capture, as `startWithIdentity` starts from data. */
  startFromCapture: (identityId: string) => Promise<StepTiming[]>;
  /** Holds the restore payload back this long, with the page already behind the barrier. */
  setRestoreDelay: (ms: number) => void;
  /** Holds every later run of `step` back this long before it starts. */
  setStepDelay: (step: HookStep, ms: number) => void;
  /** Fails the next run of `step` once, before it starts. */
  failNext: (step: HookStep) => void;
  /** Replays an earlier operation's agent replies ahead of each new link's own, while on. */
  replayStale: (on: boolean) => void;
  /** How many stale replies the replay delivered. */
  staleDelivered: () => number;
  timings: () => StepTiming[][];
}

/**
 * Installs the POC's test handles on `scope` and drives `hooks` and the agent links of `onConnect`.
 * Only test builds call this, so a published bundle never contains it.
 */
export function installTestHandles(
  scope: object,
  commands: WorkspaceCommands,
  hooks: BootstrapHooks,
  onConnect: ConnectEvent,
): void {
  const stale = replayStaleReplies(onConnect);
  const delays = new Map<HookStep, number>();
  let failing: HookStep | undefined;
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
    const delayMs = delays.get(step) ?? 0;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  };
  const handles: PocHandles = {
    // Async, so data that fails its schema rejects rather than throws.
    startWithIdentity: async (url, data) =>
      kept(commands.startWithIdentity(url, v.parse(IdentityDataSchema, data))),
    captureIdentity: (identityId) => commands.captureIdentity(identityId),
    startFromCapture: (identityId) => kept(commands.startFromCapture(identityId)),
    setRestoreDelay: (ms) => delays.set("restore", ms),
    setStepDelay: (step, ms) => delays.set(step, ms),
    failNext: (step) => {
      failing = step;
    },
    replayStale: stale.setActive,
    staleDelivered: stale.delivered,
    timings: () => runs,
  };
  Object.assign(scope, { recnrunPoc: handles });
}
