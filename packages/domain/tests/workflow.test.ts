import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import { StartResultSchema, WorkflowDraftSchema, WorkflowSchema } from "../src/index.ts";
import { sampleWorkflows } from "./fixtures.ts";

function workflow(changes: Record<string, unknown>) {
  const [first] = sampleWorkflows();
  return { ...first, ...changes };
}

describe("WorkflowSchema", () => {
  test("accepts the samples", () => {
    for (const sample of sampleWorkflows()) expect(v.is(WorkflowSchema, sample)).toBe(true);
  });

  test("trims the title and rejects a blank one", () => {
    expect(v.parse(WorkflowSchema, workflow({ title: "  Login  " })).title).toBe("Login");
    expect(v.is(WorkflowSchema, workflow({ title: "   " }))).toBe(false);
  });

  test("keeps the description optional", () => {
    const { description: _dropped, ...rest } = workflow({});
    expect(v.is(WorkflowSchema, rest)).toBe(true);
  });

  test("rejects an unknown status, a malformed tag, and a date that is not ISO", () => {
    expect(v.is(WorkflowSchema, workflow({ status: "paused" }))).toBe(false);
    expect(v.is(WorkflowSchema, workflow({ tags: ["env local"] }))).toBe(false);
    expect(v.is(WorkflowSchema, workflow({ createdAt: "yesterday" }))).toBe(false);
  });
});

describe("WorkflowDraftSchema", () => {
  test("needs only a title and tags", () => {
    expect(v.is(WorkflowDraftSchema, { title: "Login", tags: [] })).toBe(true);
    expect(v.is(WorkflowDraftSchema, { tags: [] })).toBe(false);
  });
});

describe("StartResultSchema", () => {
  test("accepts a recording result and a permission request", () => {
    const [first] = sampleWorkflows();
    expect(v.is(StartResultSchema, { status: "recording", workflow: first })).toBe(true);
    expect(
      v.is(StartResultSchema, { status: "permission-required", origins: ["http://localhost/*"] }),
    ).toBe(true);
    expect(v.is(StartResultSchema, { status: "recording" })).toBe(false);
  });
});
