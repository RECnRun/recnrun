import { sampleStep, sampleSteps } from "@recnrun/domain/testing";
import { expect, test } from "vite-plus/test";
import { formatStepTime, mergeStep, stepLabel } from "@/features/timeline/step-view";

test("formats the recording time as UTC hours, minutes, and seconds", () => {
  expect(formatStepTime("2026-10-01T09:30:04.250Z")).toBe("09:30:04");
});

test("labels a step with its command and selector, or value when it has no selector", () => {
  expect(stepLabel(sampleSteps()[3] ?? sampleStep())).toBe('click [data-testid="sign-in"]');
  expect(stepLabel(sampleStep())).toBe("navigate http://localhost:3000/login");
  expect(stepLabel({ ...sampleStep(), command: "press", selector: "#email", value: "Enter" })).toBe(
    "press #email Enter",
  );
});

test("merging appends new steps in time order and ignores a step already listed", () => {
  const [first, second, third] = sampleSteps();
  if (!first || !second || !third) throw new Error("fixture");
  const steps = mergeStep([first, third], second);
  expect(steps.map((step) => step.id)).toEqual(["step-1", "step-2", "step-3"]);
  expect(mergeStep(steps, { ...second, command: "changed" })).toBe(steps);
});
