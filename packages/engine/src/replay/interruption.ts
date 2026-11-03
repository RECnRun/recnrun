import { isReadOnlyStep, type AdapterEvent, type Step } from "@recnrun/protocol";
import type { ReplayDriver } from "./driver.ts";
import { CONNECTION_LOST, type StepOutcome } from "./outcome.ts";

type ConnectionLost = Extract<AdapterEvent, { type: "connection.lost" }>;

/** The run's connection to Chrome: once lost, nothing a step waits for can still answer. */
export interface Interruption {
  /** The loss, once it happened. */
  lost(): ConnectionLost | undefined;
  /** Resolves with the loss; never rejects, and never resolves while the connection holds. */
  readonly next: Promise<ConnectionLost>;
}

/** Watches the driver's connection; `onLost` journals the loss as the adapter's gap. */
export function watchConnection(driver: ReplayDriver, onLost: (event: ConnectionLost) => void) {
  let lost: ConnectionLost | undefined;
  let resolve: (event: ConnectionLost) => void = () => {};
  const next = new Promise<ConnectionLost>((settle) => (resolve = settle));
  const stop = driver.onEvent?.((event) => {
    if (event.type !== "connection.lost") return;
    onLost(event);
    lost ??= event;
    resolve(event);
  });
  const interruption: Interruption = { lost: () => lost, next };
  return { interruption, stop: () => stop?.() };
}

/** A write cut short may have reached the page, so its effect is unknown; a read changed nothing. */
function cutShort(step: Step, lost: ConnectionLost): StepOutcome {
  const cause = `The connection to Chrome was lost (collector gap ${lost.gap.reason}) while this step ran`;
  if (isReadOnlyStep(step))
    return { status: "cancelled", error: { code: CONNECTION_LOST, message: `${cause}.` } };
  const message = `${cause}; its effect on the page is unknown.`;
  return { status: "indeterminate", error: { code: CONNECTION_LOST, message } };
}

/** The step's outcome, or its cut-short one as soon as the connection is lost under it. */
export async function untilLost(
  step: Step,
  execution: Promise<StepOutcome>,
  interruption: Interruption,
): Promise<StepOutcome> {
  const outcome = await Promise.race([execution, interruption.next.then(() => undefined)]);
  const lost = interruption.lost();
  // A step that passed before the loss keeps its pass; anything else ended because of it.
  if (outcome?.status === "passed" || !lost) return outcome ?? (await execution);
  return { ...cutShort(step, lost), ...(outcome?.attempts && { attempts: outcome.attempts }) };
}
