import type { LocatorEntry, Target } from "@recnrun/protocol";

const HIDDEN_KEYS = new Set(["strategy", "id", "within", "filter", "has", "args"]);

function describeLocator(entry: LocatorEntry): string {
  const strategy = "strategy" in entry ? `${entry.strategy} ` : "";
  const parts = Object.entries(entry)
    .filter(([key, value]) => !HIDDEN_KEYS.has(key) && value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  return `${strategy}${parts.join(" ")}`;
}

/** One line per target: a CSS string, a single locator, or each alternative of a list. */
function describeTarget(target: Target): string {
  if (typeof target === "string") return `css=${JSON.stringify(target)}`;
  if ("locators" in target) return target.locators.map(describeLocator).join(" | ");
  return describeLocator(target);
}

export function TargetText({ target }: { target: Target }) {
  return <code class="target">{describeTarget(target)}</code>;
}
