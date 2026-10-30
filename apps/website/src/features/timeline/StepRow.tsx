import type { Step } from "@recnrun/domain";
import { formatStepTime, stepLabel } from "@/features/timeline/step-view";

export function StepRow({ step }: { step: Step }) {
  return (
    <li class="step">
      <time dateTime={step.recordedAt}>{formatStepTime(step.recordedAt)}</time>
      <span class="step-label">{stepLabel(step)}</span>
      <span class="badges">
        <span class={`badge author author-${step.author}`}>{step.author}</span>
        <span class="badge tab">tab {step.tabId}</span>
      </span>
      <span class="step-url muted">{step.url}</span>
    </li>
  );
}
