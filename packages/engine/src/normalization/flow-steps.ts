import type {
  AssertionStep,
  LocatorEntry,
  LocatorList,
  Step,
  SuggestedStep,
  Target,
} from "@recnrun/protocol";

/** The first candidate in the one-key form F2.5 replay resolves; locator lists replay in F3. */
function replayTarget(list: LocatorList): Target {
  const [first] = list.locators;
  return first === undefined ? list : shorthandOf(first);
}

function shorthandOf(entry: LocatorEntry): Target {
  if (!("strategy" in entry)) return entry;
  if (entry.strategy === "testId") return { testId: entry.value };
  if (entry.strategy === "css") return { css: entry.value };
  if (entry.strategy === "role") {
    const { role, name, exact } = entry;
    return { role, ...(name !== undefined && { name }), ...(exact !== undefined && { exact }) };
  }
  return entry;
}

const optional = (list: LocatorList | undefined) => (list ? { target: replayTarget(list) } : {});

const baseOf = ({ id, actor }: SuggestedStep) => ({ id, ...(actor && { actor }) });

/** A suggestion as a flow step; dblclick, drag, and scroll have no replay action yet. */
function stepOf(suggestion: SuggestedStep): Step | undefined {
  const base = baseOf(suggestion);
  switch (suggestion.action) {
    case "navigate":
      return { ...base, action: "navigate", url: suggestion.url };
    case "click":
      return { ...base, action: "click", target: replayTarget(suggestion.target) };
    case "fill":
    case "type":
    case "select": {
      const { action, value } = suggestion;
      return { ...base, action, target: replayTarget(suggestion.target), value };
    }
    case "keyPress":
      return { ...base, action: "keyPress", key: suggestion.key, ...optional(suggestion.target) };
    case "dblclick":
    case "drag":
    case "scroll":
      return undefined;
  }
}

/** The steps of a flow from a session's suggestions, in their order. */
export function toFlowSteps(suggestions: SuggestedStep[]): Step[] {
  return suggestions.flatMap((suggestion) => stepOf(suggestion) ?? []);
}

/** A drafted assertion whose picked locator list is narrowed to the shorthand replay resolves. */
export function replayableAssertion(step: AssertionStep): AssertionStep {
  if (!("target" in step) || typeof step.target === "string" || !("locators" in step.target))
    return step;
  return { ...step, target: replayTarget(step.target) } as AssertionStep;
}
