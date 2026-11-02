import type { DomPayload } from "@recnrun/protocol";

// Keys whose effect is not text: replaying them as part of a fill would lose their behavior.
const SPECIAL_KEYS = new Set([
  "Enter",
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock"]);

const MODIFIER_NAMES = { alt: "Alt", ctrl: "Control", meta: "Meta", shift: "Shift" } as const;

/** The combo of a special key or of a key held with Control, Alt, or Meta, such as `Control+k`. */
export function shortcutOf(payload: DomPayload): string | undefined {
  const { key } = payload;
  if (!key || MODIFIER_KEYS.has(key)) return undefined;
  const modifiers = payload.modifiers ?? [];
  const command = modifiers.some((modifier) => modifier !== "shift");
  if (!command && !SPECIAL_KEYS.has(key)) return undefined;
  return [...modifiers.map((modifier) => MODIFIER_NAMES[modifier]), key].join("+");
}

/** The key a keydown outside a text field presses; a lone modifier presses nothing. */
export function pressedKey(payload: DomPayload): string | undefined {
  const { key } = payload;
  if (!key || MODIFIER_KEYS.has(key)) return undefined;
  return shortcutOf(payload) ?? key;
}
