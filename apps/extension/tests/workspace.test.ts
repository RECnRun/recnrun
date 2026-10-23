import { sampleSnapshot } from "@recnrun/domain/testing";
import { expect, test } from "vite-plus/test";
import { toRecordingViews } from "@/dashboard/recording-view";
import { groupByWorkspace, workspaceName, workspaceParam } from "@/dashboard/workspace";

test("reads a web origin from the workspace parameter", () => {
  expect(workspaceParam("?workspace=https%3A%2F%2Fshop.example")).toBe("https://shop.example");
  expect(workspaceParam("?workspace=http%3A%2F%2Flocalhost%3A3000")).toBe("http://localhost:3000");
});

test("ignores a missing workspace, or one that is not a web origin", () => {
  expect(workspaceParam("")).toBeUndefined();
  expect(workspaceParam("?workspace=not%20a%20url")).toBeUndefined();
  expect(workspaceParam("?workspace=https%3A%2F%2Fshop.example%2Fcart")).toBeUndefined();
  expect(workspaceParam("?workspace=file%3A%2F%2F%2Ftmp")).toBeUndefined();
  expect(workspaceParam("?workspace=javascript%3Aalert(1)")).toBeUndefined();
});

test("names a workspace after its host", () => {
  expect(workspaceName("http://localhost:3000")).toBe("localhost:3000");
});

test("groups recordings by workspace, the one with the newest recording first", () => {
  const recordings = [
    ...sampleSnapshot().recordings,
    {
      id: "rec-search",
      name: "Search the catalog",
      startUrl: "https://staging.shop.example/search",
      createdAt: "2026-09-30T08:00:00.000Z",
      durationMs: 5_000,
      eventCount: 3,
    },
  ];
  const groups = groupByWorkspace(toRecordingViews(recordings));
  expect(
    groups.map(({ workspace, recordings }) => [workspace, recordings.map(({ id }) => id)]),
  ).toEqual([
    ["https://staging.shop.example", ["rec-checkout", "rec-search"]],
    ["http://localhost:3000", ["rec-login"]],
  ]);
});
