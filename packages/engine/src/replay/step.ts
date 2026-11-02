import type { ActionStep, Step } from "@recnrun/protocol";
import { runWrite, selectTab } from "./actions.ts";
import { runAssertion } from "./assertions.ts";
import { failure, StepFailure, type StepOutcome } from "./outcome.ts";
import { extractAttribute, extractText, waitFor } from "./reads.ts";
import type { StepContext } from "./step-context.ts";

function runAction(step: ActionStep, context: StepContext): Promise<StepOutcome> {
  if (step.action === "waitFor") return waitFor(step, context);
  if (step.action === "extractText") return extractText(step, context);
  if (step.action === "extractAttribute") return extractAttribute(step, context);
  if (step.action === "selectTab") return selectTab(step, context);
  return runWrite(step, context);
}

/**
 * Runs one step to its outcome. Interpolation and reads that throw become a failure; a write
 * reports its own outcome, so a throw here never hides a dispatched action.
 */
export async function executeStep(step: Step, context: StepContext): Promise<StepOutcome> {
  try {
    if ("action" in step) return await runAction(step, context);
    if ("assertion" in step) return await runAssertion(step, context);
    return failure(new StepFailure("unsupported-step", `${step.builtin} runs from F4A.4 on.`));
  } catch (error) {
    return failure(error);
  }
}
