import { type Event, type StepResult, StepResultSchema } from "@recnrun/protocol";
import { check } from "@/api/schema";

/** The step result a replay's journal event reports: `step.started` is running, `step.finished` carries the result. */
export function stepResultOf(event: Event): StepResult | undefined {
  if (event.category !== "step" || event.stepId === undefined) return undefined;
  if (event.type === "step.started") return { stepId: event.stepId, status: "running" };
  if (event.type !== "step.finished") return undefined;
  const { index: _index, ...result } = event.payload;
  const checked = check(StepResultSchema, { ...result, stepId: event.stepId });
  return checked.ok ? checked.value : undefined;
}
