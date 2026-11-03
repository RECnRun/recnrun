import type { LocatorEntry, LocatorList } from "@recnrun/protocol";
import type { DomTarget } from "./types.ts";

/** What a target offers a locator; the accessible name comes from callers that know it. */
export type LocatorHints = DomTarget & { accessibleName?: string };

const IDENTIFIER = /^[A-Za-z_][\w-]*$/;

const quote = (text: string) => `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const css = (value: string): LocatorEntry => ({ strategy: "css", value });

const idSelector = (id: string) => (IDENTIFIER.test(id) ? `#${id}` : `[id=${quote(id)}]`);

function fallback(target: LocatorHints): string {
  const type = target.inputType ? `[type=${quote(target.inputType)}]` : "";
  const role = target.role ? `[role=${quote(target.role)}]` : "";
  return `${target.tag}${type}${role}`;
}

/** Candidates in order: testId, role with its name, id, name; CSS from the tag only when none exists. */
export function suggestLocators(target: LocatorHints): LocatorList {
  const locators: LocatorEntry[] = [];
  if (target.testId) locators.push({ strategy: "testId", value: target.testId });
  // A bare role matches many elements, and orderedFallback stops at an ambiguous match.
  if (target.role && target.accessibleName) {
    locators.push({
      strategy: "role",
      role: target.role,
      name: target.accessibleName,
      exact: true,
    });
  }
  if (target.id) locators.push(css(idSelector(target.id)));
  if (target.name) locators.push(css(`${target.tag}[name=${quote(target.name)}]`));
  if (locators.length === 0) locators.push(css(fallback(target)));
  return { resolution: "orderedFallback", cardinality: "one", locators };
}
