import type { Step } from "@recnrun/domain";

/** UTC `HH:MM:SS`, so a timeline reads the same on every machine. */
export function formatStepTime(iso: string): string {
  return new Date(iso).toISOString().slice(11, 19);
}

export function stepLabel(step: Step): string {
  return [step.command, step.selector, step.value].filter((part) => part !== undefined).join(" ");
}

/** Inserts a step in time order; returns the same array when the step is already listed. */
export function mergeStep(steps: Step[], step: Step): Step[] {
  if (steps.some((listed) => listed.id === step.id)) return steps;
  return [...steps, step].sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
}
