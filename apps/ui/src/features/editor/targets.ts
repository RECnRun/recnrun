import type { LocatorEntry, Target } from "@recnrun/protocol";

/** Strategies the forms accept as one typed locator with a `value`. */
export const FORM_STRATEGIES = ["css", "testId", "text", "label"] as const;

export type FormStrategy = (typeof FORM_STRATEGIES)[number];

export type TypedLocator = { strategy: FormStrategy; value: string };

export const EMPTY_LOCATOR: TypedLocator = { strategy: "css", value: "" };

/** The one-key locator replay resolves; locator lists replay in F4A.1. */
export function locatorFrom(strategy: FormStrategy, value: string): Target {
  if (strategy === "testId") return { testId: value };
  if (strategy === "text") return { text: value };
  if (strategy === "label") return { label: value };
  return { css: value };
}

/** A picked candidate in the one-key form replay resolves, as the engine narrows a recording. */
export function shorthandOf(entry: LocatorEntry): Target {
  if (!("strategy" in entry)) return entry;
  if (entry.strategy === "testId") return { testId: entry.value };
  if (entry.strategy === "css") return { css: entry.value };
  if (entry.strategy === "role") {
    const { role, name, exact } = entry;
    return { role, ...(name !== undefined && { name }), ...(exact !== undefined && { exact }) };
  }
  return entry;
}
