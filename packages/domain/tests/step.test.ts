import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import { StepDraftSchema, StepSchema } from "../src/index.ts";
import { sampleSteps } from "./fixtures.ts";

function step(changes: Record<string, unknown>) {
  const [first] = sampleSteps();
  return { ...first, ...changes };
}

describe("StepSchema", () => {
  test("accepts the samples", () => {
    for (const sample of sampleSteps()) expect(v.is(StepSchema, sample)).toBe(true);
  });

  test("keeps selector and value optional", () => {
    const { selector: _s, value: _v, ...rest } = step({});
    expect(v.is(StepSchema, rest)).toBe(true);
  });

  test("rejects an unknown author, an empty command, and a fractional tab id", () => {
    expect(v.is(StepSchema, step({ author: "robot" }))).toBe(false);
    expect(v.is(StepSchema, step({ command: "" }))).toBe(false);
    expect(v.is(StepSchema, step({ tabId: 1.5 }))).toBe(false);
  });

  test("rejects a URL that is not absolute", () => {
    expect(v.is(StepSchema, step({ url: "/login" }))).toBe(false);
  });
});

describe("StepDraftSchema", () => {
  test("is a step without its identity", () => {
    const { id: _id, workflowId: _w, tabId: _t, ...draft } = step({});
    expect(v.is(StepDraftSchema, draft)).toBe(true);
    expect(v.is(StepDraftSchema, step({}))).toBe(true);
  });
});
