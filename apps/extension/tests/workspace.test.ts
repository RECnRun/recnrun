import { sampleSnapshot } from "@recnrun/domain/testing";
import { expect, test } from "vite-plus/test";
import { toRecordingViews } from "@/dashboard/recording-view";
import { groupByWorkspace, workspaceName } from "@/dashboard/workspace";

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
