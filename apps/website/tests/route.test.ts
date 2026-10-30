import { expect, test } from "vite-plus/test";
import { parseRoute, workflowHref } from "@/app/route";

test("the root and unknown hashes list workflows", () => {
  expect(parseRoute("")).toEqual({ name: "workflows" });
  expect(parseRoute("#/")).toEqual({ name: "workflows" });
  expect(parseRoute("#/workflows/")).toEqual({ name: "workflows" });
  expect(parseRoute("#/workflows/a/b")).toEqual({ name: "workflows" });
  expect(parseRoute("#/other")).toEqual({ name: "workflows" });
});

test("a workflow hash carries its decoded id", () => {
  expect(parseRoute("#/workflows/wf-login")).toEqual({ name: "workflow", id: "wf-login" });
  expect(parseRoute(workflowHref("a b/c"))).toEqual({ name: "workflow", id: "a b/c" });
});
