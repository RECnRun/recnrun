import { checkCapturedEvent, type CapturedEvent, type SuggestedStep } from "@recnrun/protocol";
import { describe, expect, test } from "vite-plus/test";
import { normalize } from "../src/index.ts";

type Details = Record<string, unknown> & { commandId?: string };
type Target = { tag: string; id?: string; testId?: string; role?: string; inputType?: string };

/** Builds schema-checked events of one producer, one per call, at `ms` after a fixed start. */
function recorder() {
  const events: CapturedEvent[] = [];
  // `kind` is "<category>/<type>"; `extra` overrides envelope fields such as commandId.
  const emit = (ms: number, kind: string, payload: object, extra: object = {}) => {
    const [category, type] = kind.split("/");
    const seq = events.length + 1;
    const event = {
      schemaVersion: 1,
      id: `cdp:S1#${seq}`,
      runId: "rec-1",
      seq,
      source: "S1",
      producer: "cdp:S1",
      timestamp: new Date(Date.UTC(2026, 10, 2, 10) + ms).toISOString(),
      targetId: "T1",
      frameId: "T1",
      documentId: "D1",
      ...extra,
      category,
      type,
      payload,
    };
    expect(checkCapturedEvent(event)).toEqual({ ok: true });
    events.push(event as CapturedEvent);
  };
  const dom = (ms: number, type: string, target: Target, details: Details = {}) => {
    const { commandId, ...rest } = details;
    const extra = commandId === undefined ? {} : { commandId };
    emit(ms, `dom/${type}`, { target, isTrusted: true, ...rest }, extra);
  };
  const key = (ms: number, target: Target, name: string, modifiers: string[] = []) =>
    dom(ms, "keydown", target, { key: name, code: name, repeat: false, modifiers });
  const input = (ms: number, target: Target, edit: [string, string | null], value: string) =>
    dom(ms, "input", target, { inputType: edit[0], data: edit[1], isComposing: false, value });
  const navigate = (ms: number, url: string, type = "committed") =>
    emit(ms, `navigation/${type}`, { url });
  return { events, dom, key, input, navigate };
}

const FIELD: Target = { tag: "input", testId: "field", inputType: "text" };
const NEXT: Target = { tag: "input", testId: "next", inputType: "text" };
const BUTTON: Target = { tag: "button", testId: "go" };

function detailOf(step: SuggestedStep): string {
  if ("value" in step) return ` ${step.value}`;
  if ("key" in step) return ` ${step.key}`;
  return "url" in step ? ` ${step.url}` : "";
}

const summary = (steps: SuggestedStep[]) =>
  steps.map((step) => `${step.action}${detailOf(step)} (${step.events.length})`);

describe("normalization rules beyond the goldens", () => {
  test("a corrected typo and a paste still explain the value, so the run is one fill", () => {
    const r = recorder();
    r.input(0, FIELD, ["insertText", "a"], "a");
    r.input(10, FIELD, ["insertText", "x"], "ax");
    r.input(20, FIELD, ["deleteContentBackward", null], "a");
    r.input(30, FIELD, ["insertFromPaste", "bc"], "abc");
    r.dom(40, "focusout", FIELD);
    expect(summary(normalize(r.events).steps)).toEqual(["fill abc (4)"]);
  });

  test("Backspace and Delete keys the value explains stay inside one fill", () => {
    const r = recorder();
    r.key(0, FIELD, "a");
    r.input(1, FIELD, ["insertText", "a"], "a");
    r.key(10, FIELD, "x");
    r.input(11, FIELD, ["insertText", "x"], "ax");
    r.key(20, FIELD, "Backspace");
    r.input(21, FIELD, ["deleteContentBackward", null], "a");
    r.key(30, FIELD, "Delete");
    r.input(31, FIELD, ["deleteContentForward", null], "a");
    r.dom(40, "focusout", FIELD);
    expect(summary(normalize(r.events).steps)).toEqual(["fill a (8)"]);
  });

  test("a deletion key after a special key is pressed on replay, even past the typed text", () => {
    const r = recorder();
    r.input(0, FIELD, ["insertText", "a"], "a");
    r.key(10, FIELD, "Home");
    r.key(20, FIELD, "Delete");
    r.input(21, FIELD, ["deleteContentForward", null], "");
    r.key(30, FIELD, "Backspace");
    r.dom(40, "focusout", FIELD);
    expect(summary(normalize(r.events).steps)).toEqual([
      "type a (1)",
      "keyPress Home (1)",
      "keyPress Delete (2)",
      "keyPress Backspace (1)",
    ]);
  });

  test("Tab after typing is a keyPress after the fill, and its keyup on the next field joins it", () => {
    const r = recorder();
    r.key(0, FIELD, "a");
    r.input(1, FIELD, ["insertText", "a"], "a");
    r.key(100, FIELD, "Tab");
    r.dom(101, "change", FIELD, { value: "a" });
    r.dom(102, "focusout", FIELD);
    r.dom(150, "keyup", NEXT, { key: "Tab", code: "Tab", repeat: false, modifiers: [] });
    expect(summary(normalize(r.events).steps)).toEqual(["fill a (3)", "keyPress Tab (2)"]);
  });

  test("a key pressed in a field with no input is a keyPress on that field", () => {
    const r = recorder();
    r.key(0, FIELD, "Tab", ["shift"]);
    r.dom(1, "focusout", FIELD);
    const [step] = normalize(r.events).steps;
    expect(step).toMatchObject({
      action: "keyPress",
      key: "Shift+Tab",
      target: { locators: [{ strategy: "testId", value: "field" }] },
    });
  });

  test("Enter in a field submits the form: fill, keyPress Enter, and no navigate", () => {
    const r = recorder();
    r.input(0, FIELD, ["insertText", "q"], "q");
    r.key(100, FIELD, "Enter");
    r.dom(101, "click", { tag: "button", testId: "search", inputType: "submit" }, { detail: 0 });
    r.dom(102, "submit", { tag: "form" });
    r.navigate(400, "http://127.0.0.1:4600/results");
    const result = normalize(r.events);
    expect(summary(result.steps)).toEqual(["fill q (1)", "keyPress Enter (3)"]);
    expect(result.excluded).toEqual([
      { event: { id: "cdp:S1#5", producer: "cdp:S1", seq: 5 }, reason: "navigation-caused" },
    ]);
  });

  test("Space on a button is one keyPress: the click it fires joins it", () => {
    const r = recorder();
    r.key(0, BUTTON, " ");
    r.dom(5, "click", BUTTON, { detail: 0 });
    expect(summary(normalize(r.events).steps)).toEqual(["keyPress   (2)"]);
  });

  test("a same-document navigation after a role=link click and a redirect after a navigate are not steps", () => {
    const r = recorder();
    r.dom(0, "click", { tag: "span", role: "link" }, { detail: 1 });
    r.navigate(50, "http://127.0.0.1:4600/#/next", "same-document");
    r.navigate(5000, "http://127.0.0.1:4600/old");
    r.navigate(5100, "http://127.0.0.1:4600/new");
    const result = normalize(r.events);
    expect(summary(result.steps)).toEqual(["click (1)", "navigate http://127.0.0.1:4600/old (1)"]);
    expect(result.excluded.map((excluded) => excluded.event.seq)).toEqual([2, 4]);
  });

  test("a dblclick with no counted clicks before it, and a select changed without input", () => {
    const r = recorder();
    r.dom(0, "dblclick", BUTTON, { detail: 2 });
    r.dom(500, "change", { tag: "select", testId: "plan" }, { value: "pro" });
    expect(summary(normalize(r.events).steps)).toEqual(["dblclick (1)", "select pro (1)"]);
  });

  test("only the listed command ids are replay-caused", () => {
    const r = recorder();
    r.dom(0, "click", BUTTON, { detail: 1, commandId: "agent-1" });
    r.dom(1000, "click", NEXT, { detail: 1, commandId: "replay-1" });
    const result = normalize(r.events, { replayCommandIds: ["replay-1"] });
    expect(summary(result.steps)).toEqual(["click (1)"]);
    expect(result.excluded).toEqual([
      {
        event: { id: "cdp:S1#2", producer: "cdp:S1", seq: 2 },
        reason: "replay-caused",
        replayCaused: true,
      },
    ]);
  });

  test("text typed and then deleted between keys leaves no empty type step; its events join the step before", () => {
    const r = recorder();
    r.key(0, FIELD, "ArrowDown");
    r.input(10, FIELD, ["insertText", "a"], "a");
    r.input(20, FIELD, ["deleteContentBackward", null], "");
    r.key(30, FIELD, "ArrowDown");
    r.input(40, FIELD, ["insertText", "b"], "b");
    r.dom(50, "focusout", FIELD);
    expect(summary(normalize(r.events).steps)).toEqual([
      "keyPress ArrowDown (3)",
      "keyPress ArrowDown (1)",
      "type b (1)",
    ]);
  });
});
