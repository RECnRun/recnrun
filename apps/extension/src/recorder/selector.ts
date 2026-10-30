const TEXT_TAGS = new Set(["A", "BUTTON"]);
const MAX_TEXT = 40;

/** A selector a person or an agent can re-run later: stable attributes first, a DOM path last. */
export function selectorFor(element: Element): string {
  return (
    uniqueAttribute(element, "data-testid") ??
    uniqueId(element) ??
    uniqueAttribute(element, "name") ??
    uniqueAttribute(element, "aria-label") ??
    byText(element) ??
    path(element)
  );
}

function uniqueAttribute(element: Element, name: string): string | undefined {
  const value = element.getAttribute(name);
  if (value === null || value === "") return undefined;
  return unique(element, `[${name}="${escapeValue(value)}"]`);
}

function uniqueId(element: Element): string | undefined {
  return element.id === "" ? undefined : unique(element, `#${CSS.escape(element.id)}`);
}

function byText(element: Element): string | undefined {
  if (!TEXT_TAGS.has(element.tagName)) return undefined;
  const text = element.textContent.trim().replaceAll(/\s+/g, " ");
  if (text === "" || text.length > MAX_TEXT) return undefined;
  const tag = element.tagName.toLowerCase();
  const matches = [...element.ownerDocument.querySelectorAll(tag)].filter(
    (candidate) => candidate.textContent.trim().replaceAll(/\s+/g, " ") === text,
  );
  return matches.length === 1 ? `${tag}:has-text("${escapeValue(text)}")` : undefined;
}

/** `#nearest-id > tag:nth-of-type(n) > …`, or from `body` when no ancestor has an id. */
function path(element: Element): string {
  const segments: string[] = [];
  let current: Element | null = element;
  while (current && current.tagName !== "BODY") {
    if (current !== element && current.id !== "") {
      segments.unshift(`#${CSS.escape(current.id)}`);
      return segments.join(" > ");
    }
    segments.unshift(segment(current));
    current = current.parentElement;
  }
  segments.unshift("body");
  return segments.join(" > ");
}

function segment(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const siblings = [...(element.parentElement?.children ?? [])].filter(
    (sibling) => sibling.tagName === element.tagName,
  );
  if (siblings.length === 1) return tag;
  return `${tag}:nth-of-type(${siblings.indexOf(element) + 1})`;
}

function unique(element: Element, selector: string): string | undefined {
  const matches = element.ownerDocument.querySelectorAll(selector);
  return matches.length === 1 && matches[0] === element ? selector : undefined;
}

function escapeValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
