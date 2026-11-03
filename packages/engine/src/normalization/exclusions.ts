import type { CapturedEvent, ExcludedEvent } from "@recnrun/protocol";
import { isDomEvent, refOf, type DomTarget, type Settings } from "./types.ts";

function isReplayCaused(event: CapturedEvent, settings: Settings): boolean {
  if (typeof event.commandId !== "string") return false;
  return settings.replayCommandIds?.has(event.commandId) ?? true;
}

const isOverlay = (target: DomTarget, prefix: string) =>
  Boolean(target.testId?.startsWith(prefix) || target.id?.startsWith(prefix));

/** Why an event cannot become part of a suggestion, or undefined when it can. */
export function exclusionOf(event: CapturedEvent, settings: Settings): ExcludedEvent | undefined {
  if (isReplayCaused(event, settings)) {
    return { event: refOf(event), reason: "replay-caused", replayCaused: true };
  }
  if (!isDomEvent(event)) return undefined;
  if (isOverlay(event.payload.target, settings.overlayPrefix)) {
    return { event: refOf(event), reason: "recorder-overlay" };
  }
  // Synthetic events come from page scripts; they stay as evidence, never as a person's step.
  if (!event.payload.isTrusted) return { event: refOf(event), reason: "untrusted" };
  return undefined;
}
