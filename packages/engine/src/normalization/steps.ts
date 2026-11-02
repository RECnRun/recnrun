import type { CapturedEvent, SuggestedStep } from "@recnrun/protocol";
import { suggestLocators } from "./locators.ts";
import { refOf, type DomTarget, type Draft, type Settings } from "./types.ts";

type Base = Pick<SuggestedStep, "id" | "actor" | "events">;
// Omit over each member of the union, so the step-specific fields stay tied to their action.
type Shape = SuggestedStep extends infer S
  ? S extends unknown
    ? Omit<S, keyof Base>
    : never
  : never;

const lookup = (names: Record<string, string>, key: string | undefined) =>
  key !== undefined && Object.hasOwn(names, key) ? names[key] : undefined;

/** The actor of the session or binding behind the producer; `isTrusted` never decides it. */
function actorOf(event: CapturedEvent | undefined, settings: Settings): string | undefined {
  return (
    lookup(settings.producers, event?.producer) ?? lookup(settings.bindings, event?.profileBinding)
  );
}

const optionalTarget = (target: DomTarget | undefined) =>
  target ? { target: suggestLocators(target) } : {};

const redactedOf = (redacted: true | undefined) => (redacted ? { redacted } : {});

function shapeOf(draft: Draft): Shape {
  switch (draft.action) {
    case "navigate":
      return { action: draft.action, url: draft.url };
    case "click":
    case "dblclick":
      return { action: draft.action, target: suggestLocators(draft.target) };
    case "drag":
      return {
        action: draft.action,
        target: suggestLocators(draft.target),
        to: suggestLocators(draft.to),
      };
    case "fill":
    case "type":
    case "select": {
      const { action, value } = draft;
      return {
        action,
        target: suggestLocators(draft.target),
        value,
        ...redactedOf(draft.redacted),
      };
    }
    case "keyPress":
      return { action: draft.action, key: draft.key, ...optionalTarget(draft.target) };
    case "scroll": {
      const { action, scrollX, scrollY } = draft;
      return { action, scrollX, scrollY, ...optionalTarget(draft.target) };
    }
  }
}

/** The suggestion a draft becomes: an id from its position, its actor, locators, and event refs. */
export function toStep(draft: Draft, index: number, settings: Settings): SuggestedStep {
  const actor = actorOf(draft.events[0], settings);
  const base: Base = {
    id: `${draft.action}-${index + 1}`,
    ...(actor !== undefined && { actor }),
    events: draft.events.map(refOf),
  };
  return { ...base, ...shapeOf(draft) };
}
