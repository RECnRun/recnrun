import { beforeEach, describe, expect, test } from "vite-plus/test";
import { inputError } from "./worker-extension/input-schema.js";
import { createHeld } from "./worker-extension/interact-held.js";
import { keyParams, textFits, wheelParams } from "./worker-extension/interact-keys.js";

/* W7 slice C: key, text, and wheel events, the closed key table, and the pressed state. */

const LEASE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const AIMED = {
  bootId: "11111111-2222-4333-8444-555555555555",
  sessionEpoch: 1_700_000_000_000,
  frameSeq: 7,
  loaderId: "A1B2C3D4E5F60718293A4B5C6D7E8F90",
};
const base = { type: "INPUT_EVENT", leaseId: LEASE, seq: 3, ...AIMED };
const KEY = { ...base, kind: "key", code: "Enter", phase: "down", modifiers: 0 };
const TEXT = { ...base, kind: "text", text: "Olá ação 123" };
const WHEEL = { ...base, kind: "wheel", x: 0.25, y: 0.5, deltaX: 0, deltaY: 120, modifiers: 0 };
const GEOMETRY = { deviceWidth: 1280, deviceHeight: 720, pageScaleFactor: 1, offsetTop: 0 };

describe("the key, text, and wheel messages", () => {
  test.each([
    ["key", KEY],
    ["text", TEXT],
    ["wheel", WHEEL],
  ])("a well-formed %s passes", (_name, message) => {
    expect(inputError(message)).toBeNull();
  });

  test.each([
    ["a key with a point", { ...KEY, x: 0.5 }],
    ["a key with no frame", { ...KEY, frameSeq: undefined }],
    ["a key phase outside down and up", { ...KEY, phase: "press" }],
    ["a key code with punctuation", { ...KEY, code: "Enter;" }],
    ["a native key code", { ...KEY, nativeKeyCode: 13 }],
    ["an empty text", { ...TEXT, text: "" }],
    ["a text with a control character", { ...TEXT, text: "a\rb" }],
    ["a text with a key code", { ...TEXT, code: "Enter" }],
    ["a wheel with no delta", { ...WHEEL, deltaY: undefined }],
    ["a wheel delta that is not finite", { ...WHEEL, deltaY: Number.POSITIVE_INFINITY }],
    ["a wheel delta over 10000", { ...WHEEL, deltaY: 10_001 }],
  ])("%s is refused", (_name, message) => {
    const defined = Object.fromEntries(Object.entries(message).filter(([, v]) => v !== undefined));
    expect(inputError(defined)).toBe("INVALID_REQUEST");
  });

  test("a well-formed key outside the table passes the schema, for the table to refuse", () => {
    expect(inputError({ ...KEY, code: "F5" })).toBeNull();
    expect(keyParams({ ...KEY, code: "F5" })).toBeNull();
  });
});

describe("the hold keepalive", () => {
  const HOLD = { type: "INPUT_EVENT", kind: "hold", leaseId: LEASE, seq: 4 };

  test("a hold names only its lease and seq", () => {
    expect(inputError(HOLD)).toBeNull();
  });

  test.each([
    ["a hold with a point", { ...HOLD, x: 0.5, y: 0.5 }],
    ["a hold with a frame", { ...HOLD, ...AIMED }],
    ["a hold with a button", { ...HOLD, button: "left" }],
  ])("%s is refused", (_name, message) => {
    expect(inputError(message)).toBe("INVALID_REQUEST");
  });
});

describe("the closed key table", () => {
  test("Enter types a carriage return on its down and nothing on its up", () => {
    expect(keyParams(KEY)).toEqual({
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      modifiers: 0,
      text: "\r",
      unmodifiedText: "\r",
    });
    expect(keyParams({ ...KEY, phase: "up" })).toEqual({
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      modifiers: 0,
    });
  });

  test.each([
    ["Backspace", 8],
    ["Tab", 9],
    ["Escape", 27],
    ["ArrowLeft", 37],
    ["ArrowUp", 38],
    ["ArrowRight", 39],
    ["ArrowDown", 40],
  ])("%s is a raw down with virtual key code %i and no text", (code, windowsVirtualKeyCode) => {
    const params = keyParams({ ...KEY, code, modifiers: 8 });
    expect(params).toEqual({
      type: "rawKeyDown",
      key: code,
      code,
      windowsVirtualKeyCode,
      modifiers: 8,
    });
  });

  test.each(["F5", "KeyA", "Delete", "MetaLeft", "constructor", "__proto__"])(
    "%s is outside the table",
    (code) => {
      expect(keyParams({ ...KEY, code })).toBeNull();
    },
  );

  test("no key ever carries a native key code", () => {
    for (const code of ["Enter", "Backspace", "ArrowUp"]) {
      for (const phase of ["down", "up"]) {
        expect(keyParams({ ...KEY, code, phase })).not.toHaveProperty("nativeKeyCode");
      }
    }
  });
});

describe("text and wheel limits", () => {
  test("text fits up to 4 KiB of UTF-8", () => {
    expect(textFits("a".repeat(4_096))).toBe(true);
    expect(textFits("a".repeat(4_097))).toBe(false);
    // ç is two bytes: 2 049 of them are 4 098 bytes.
    expect(textFits("ç".repeat(2_048))).toBe(true);
    expect(textFits("ç".repeat(2_049))).toBe(false);
  });

  test("a wheel maps its point and clamps its deltas", () => {
    expect(
      wheelParams({ ...WHEEL, deltaX: -5_000, deltaY: 120 }, { geometry: GEOMETRY }, 1),
    ).toEqual({
      type: "mouseWheel",
      x: 320,
      y: 360,
      deltaX: -1_000,
      deltaY: 120,
      modifiers: 0,
    });
  });
});

describe("the pressed state", () => {
  let held: ReturnType<typeof createHeld>;
  const MOUSE = "Input.dispatchMouseEvent";
  const KEYS = "Input.dispatchKeyEvent";

  beforeEach(() => {
    held = createHeld();
  });

  test("nothing is held at first and nothing is released", () => {
    expect(held.any()).toBe(false);
    expect(held.releases()).toEqual([]);
  });

  test("a held button is released where the pointer last was", () => {
    held.track(MOUSE, { type: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1 });
    held.track(MOUSE, { type: "mouseMoved", x: 30, y: 40, button: "left", clickCount: 0 });
    expect(held.any()).toBe(true);
    expect(held.releases()).toEqual([
      {
        method: MOUSE,
        params: {
          type: "mouseReleased",
          x: 30,
          y: 40,
          button: "left",
          clickCount: 1,
          modifiers: 0,
        },
      },
    ]);
  });

  test("a released button and a key let go are no longer held", () => {
    held.track(MOUSE, { type: "mousePressed", x: 1, y: 1, button: "right", clickCount: 1 });
    held.track(MOUSE, { type: "mouseReleased", x: 1, y: 1, button: "right", clickCount: 1 });
    held.track(KEYS, keyParams({ ...KEY, code: "ArrowDown" }) ?? {});
    held.track(KEYS, keyParams({ ...KEY, code: "ArrowDown", phase: "up" }) ?? {});
    expect(held.any()).toBe(false);
  });

  test("held keys go up before held buttons, each once", () => {
    held.track(MOUSE, { type: "mousePressed", x: 5, y: 6, button: "left", clickCount: 1 });
    held.track(KEYS, keyParams({ ...KEY, code: "ArrowDown" }) ?? {});
    held.track(KEYS, keyParams({ ...KEY, code: "ArrowDown" }) ?? {});
    held.track(KEYS, keyParams(KEY) ?? {});
    expect(held.size()).toBe(3);
    expect(
      held.releases().map(({ params }) => [params.type, params.code ?? params.button]),
    ).toEqual([
      ["keyUp", "ArrowDown"],
      ["keyUp", "Enter"],
      ["mouseReleased", "left"],
    ]);
    held.clear();
    expect(held.any()).toBe(false);
  });

  test("a wheel or a text holds nothing", () => {
    held.track(MOUSE, { type: "mouseWheel", x: 1, y: 1, deltaX: 0, deltaY: 1 });
    held.track("Input.insertText", { text: "x" });
    expect(held.any()).toBe(false);
  });
});
