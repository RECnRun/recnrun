import type { E4Sample, Mechanism, Trigger } from "./e4-samples.ts";
import { json, stopCall } from "./e4-steps.ts";
import type { Started, StopJournal } from "./e4-steps.ts";
import { APP } from "./page-loads.ts";
import type { Run } from "./page-loads.ts";

// How E4 applies each stop mechanism of PLAN.md P1.3 through the isolator's `recnrunStop`.
// Base 36 has no 32-hex run, which the evidence redaction would hash.
const RUN = Date.now().toString(36);

export interface Plan {
  mechanism: Mechanism;
  variant: string;
  trigger: Trigger;
  index: number;
}

/** One sample, the isolator's journal of its stop, and everything else it saw. */
export interface Outcome {
  sample: E4Sample;
  journal: StopJournal | { error: string };
  evidence: Record<string, unknown>;
}

/** How a mechanism is applied; `command` names the call whose error is Chrome's refusal. */
export interface Recipe {
  command: string;
  stop: (run: Run, started: Started) => Promise<StopJournal>;
  /** Route A keeps the tab armed through the stop, and the isolator watches its sessions. */
  held?: boolean;
  disarmBefore?: boolean;
  closeClient?: boolean;
  unlistedBoundMs: number;
  /** What else to record on a tab of the origin once the trigger ran. */
  probe?: (run: Run, tabId: number) => Promise<unknown>;
}

const SHORT: Record<Mechanism, string> = {
  "close-target": "close",
  "terminate-execution": "term",
  "debugger-pause": "pause",
  "dnr-block-evict": "dnr",
  unregister: "unreg",
};

export const target = ({ targetId }: Started) => json({ targetId });
const closeOwn = (run: Run, started: Started) => stopCall(run, `closeTarget(${target(started)})`);

const RECIPES: Record<string, Recipe> = {
  "close-target": { command: "Target.closeTarget", stop: closeOwn, unlistedBoundMs: 10_000 },
  "close-target/tab-session": {
    command: "Target.closeTarget",
    stop: (run, { targetId, tabId }) =>
      stopCall(run, `closeTarget(${json({ targetId, via: "tab", tabId })})`),
    unlistedBoundMs: 10_000,
  },
  "close-target/held": {
    command: "Target.closeTarget",
    stop: closeOwn,
    held: true,
    unlistedBoundMs: 10_000,
  },
  "terminate-execution": {
    command: "Runtime.terminateExecution",
    stop: (run, started) => stopCall(run, `terminateExecution(${target(started)})`),
    unlistedBoundMs: 3_000,
  },
  "debugger-pause": {
    command: "Debugger.pause",
    stop: (run, started) => stopCall(run, `pauseHold(${target(started)})`),
    unlistedBoundMs: 0,
  },
  "dnr-block-evict": {
    command: "updateSessionRules",
    stop: (run) => stopCall(run, `blockScope(${json({ origin: APP })})`),
    disarmBefore: true,
    // Chrome stops an idle worker about 30 s after its last event, unless DevTools is attached.
    unlistedBoundMs: 40_000,
    probe: async (run, tabId) =>
      (await stopCall(run, `client(${json({ tabId, action: "update" })})`)).outcome,
  },
  unregister: {
    command: "Runtime.evaluate",
    stop: (run, { tabId }) => stopCall(run, `unregister(${json({ tabId })})`),
    closeClient: true,
    unlistedBoundMs: 10_000,
  },
};

export function recipeOf({ mechanism, variant }: Plan): Recipe {
  const how = variant.replace(/-?module$/, "");
  const recipe = RECIPES[`${mechanism}/${how}`] ?? RECIPES[mechanism];
  if (!recipe) throw new Error(`no recipe for ${mechanism}/${variant}`);
  return recipe;
}

export function markersOf({ mechanism, index }: Plan) {
  const marker = `e4-${SHORT[mechanism]}-${index}-${RUN}`;
  return { marker, restartMarker: `${marker}-r` };
}

export const scriptVariant = (plan: Plan) =>
  plan.variant.endsWith("module") ? "module" : "classic";

/** Applies the mechanism, keeping what the isolator threw instead of losing the sample. */
export async function attempt(run: Run, started: Started, recipe: Recipe) {
  return recipe.stop(run, started).catch((error: unknown) => ({ error: String(error) }));
}

/** Chrome's exact error for the stop command, or the isolator's when it threw. */
function stopErrorOf(journal: Outcome["journal"], command: string): string | undefined {
  if ("error" in journal) return journal.error;
  const refused = journal.calls.find((item) => item.method === command && item.error);
  const failure = (journal.outcome as { error?: unknown }).error;
  return refused?.error ?? (typeof failure === "string" ? failure : undefined);
}

/** The sample fields every mechanism shares, from the plan and the isolator's journal. */
export function baseOf(plan: Plan, script: string, journal: Outcome["journal"]) {
  const stopError = stopErrorOf(journal, recipeOf(plan).command);
  const ms = "error" in journal ? undefined : Math.round(journal.endedAt - journal.startedAt);
  return {
    mechanism: plan.mechanism,
    variant: plan.variant,
    trigger: plan.trigger,
    ...markersOf(plan),
    script,
    ...(stopError === undefined ? {} : { stopError }),
    ...(ms === undefined ? {} : { stopCommandMs: ms }),
  };
}
