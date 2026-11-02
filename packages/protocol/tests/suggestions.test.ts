import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import {
  checkCapturedEvent,
  checkNormalizationResult,
  NormalizationResultSchema,
  SuggestedStepSchema,
} from "../src/index.ts";

const target = {
  resolution: "orderedFallback",
  cardinality: "one",
  locators: [{ testId: "name" }],
};
const events = [{ id: "cdp:S1#4", producer: "cdp:S1", seq: 4 }];

describe("SuggestedStepSchema", () => {
  test.each([
    { id: "fill-1", action: "fill", target, value: "Ada", events },
    { id: "fill-2", action: "fill", target, value: "${secrets.password}", redacted: true, events },
    { id: "dblclick-1", action: "dblclick", actor: "solicitante", target, events },
    { id: "drag-1", action: "drag", target, to: target, events },
    { id: "keyPress-1", action: "keyPress", key: "Control+k", events },
    { id: "scroll-1", action: "scroll", scrollX: 0, scrollY: 800, events },
    { id: "navigate-1", action: "navigate", url: "http://127.0.0.1:4600/", events },
  ])("accepts $action", (step) => {
    expect(v.is(SuggestedStepSchema, step)).toBe(true);
  });

  test.each([
    ["no source events", { id: "click-1", action: "click", target, events: [] }],
    ["an unknown action", { id: "hover-1", action: "hover", target, events }],
    ["a drag without a destination", { id: "drag-1", action: "drag", target, events }],
    ["an actor that is not a name", { id: "c-1", action: "click", actor: "a b", target, events }],
  ])("rejects %s", (_label, step) => {
    expect(v.is(SuggestedStepSchema, step)).toBe(false);
  });
});

describe("normalization results", () => {
  test("an excluded event names its reason, and only replay-caused ones carry the flag", () => {
    const result = {
      steps: [],
      excluded: [{ event: events[0], reason: "replay-caused", replayCaused: true }],
    };
    expect(v.is(NormalizationResultSchema, result)).toBe(true);
    expect(checkNormalizationResult(result)).toEqual({ ok: true });
    const unknown = { steps: [], excluded: [{ event: events[0], reason: "boring" }] };
    expect(checkNormalizationResult(unknown)).toMatchObject({ ok: false });
  });

  test("checkCapturedEvent reports why a raw event is invalid", () => {
    expect(checkCapturedEvent({ category: "dom" })).toMatchObject({
      ok: false,
      message: expect.any(String),
    });
  });
});
