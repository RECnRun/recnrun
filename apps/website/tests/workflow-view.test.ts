import { sampleWorkflows } from "@recnrun/domain/testing";
import { expect, test } from "vite-plus/test";
import {
  filterWorkflows,
  formatUpdatedAt,
  upsertWorkflow,
} from "@/features/workflows/workflow-view";

test("formats the update time in UTC to the minute", () => {
  expect(formatUpdatedAt("2026-10-02T14:06:35.000Z")).toBe("2026-10-02 14:06 UTC");
});

test("an empty filter keeps every workflow in the given order", () => {
  const workflows = sampleWorkflows();
  expect(filterWorkflows(workflows, "  ")).toEqual(workflows);
});

test("filters by tag, ignoring case, and by title", () => {
  const workflows = sampleWorkflows();
  expect(filterWorkflows(workflows, "env:acc").map((w) => w.id)).toEqual(["wf-checkout"]);
  expect(filterWorkflows(workflows, "feature:").map((w) => w.id)).toEqual([
    "wf-login",
    "wf-checkout",
  ]);
  expect(filterWorkflows(workflows, "admin").map((w) => w.id)).toEqual(["wf-login"]);
  expect(filterWorkflows(workflows, "nothing")).toEqual([]);
});

test("upserting replaces a workflow by id and keeps the newest update first", () => {
  const [login, checkout] = sampleWorkflows();
  if (!login || !checkout) throw new Error("fixture");
  const stopped = { ...login, status: "stopped" as const, updatedAt: "2026-10-03T08:00:00.000Z" };
  expect(upsertWorkflow([checkout], login).map((w) => w.id)).toEqual(["wf-checkout", "wf-login"]);
  expect(upsertWorkflow([checkout, login], stopped)).toEqual([stopped, checkout]);
});
