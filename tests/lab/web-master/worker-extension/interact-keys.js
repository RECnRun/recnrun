// W7 slice C: the closed key table and the text and wheel limits; nothing else reaches the page.
import { utf8Length } from "./encoding.js";
import { toCss } from "./interact-frames.js";

const MAX_TEXT_BYTES = 4_096;
const MAX_WHEEL_DELTA = 1_000;
// Only Enter types a character; the rest are raw downs that page editing handles. No nativeKeyCode.
const KEYS = {
  Enter: { windowsVirtualKeyCode: 13, text: "\r" },
  Backspace: { windowsVirtualKeyCode: 8 },
  Tab: { windowsVirtualKeyCode: 9 },
  Escape: { windowsVirtualKeyCode: 27 },
  ArrowLeft: { windowsVirtualKeyCode: 37 },
  ArrowUp: { windowsVirtualKeyCode: 38 },
  ArrowRight: { windowsVirtualKeyCode: 39 },
  ArrowDown: { windowsVirtualKeyCode: 40 },
};

const typeOf = (down, text) => {
  if (!down) return "keyUp";
  return text ? "keyDown" : "rawKeyDown";
};

/** The Input.dispatchKeyEvent params of a key event, or null for a code outside the table. */
export const keyParams = (event) => {
  if (!Object.hasOwn(KEYS, event.code)) return null;
  const { windowsVirtualKeyCode, text } = KEYS[event.code];
  const down = event.phase === "down";
  const params = { type: typeOf(down, text), key: event.code, code: event.code };
  Object.assign(params, { windowsVirtualKeyCode, modifiers: event.modifiers });
  return down && text ? { ...params, text, unmodifiedText: text } : params;
};

export const textFits = (text) => utf8Length(text) <= MAX_TEXT_BYTES;

const clamp = (delta) => Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, delta));

/** The Input.dispatchMouseEvent params of a checked wheel event aimed at `entry`. */
export const wheelParams = (event, entry, zoom) => ({
  type: "mouseWheel",
  ...toCss(entry.geometry, event.x, event.y, zoom),
  deltaX: clamp(event.deltaX),
  deltaY: clamp(event.deltaY),
  modifiers: event.modifiers,
});
