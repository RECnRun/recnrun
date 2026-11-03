import type { Event, GapPayload } from "@recnrun/protocol";
import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { gapRows, Gaps } from "@/features/run/Gaps";
import { NOW, fakeApi, renderWith } from "./fake-api";

let seq = 0;

function gap(payload: GapPayload): Event {
  seq += 1;
  return {
    schemaVersion: 1,
    id: `adapter:connection#${seq}`,
    runId: "run-1",
    seq,
    source: "adapter",
    producer: "adapter:connection",
    timestamp: NOW,
    component: "collector",
    targetId: null,
    frameId: null,
    documentId: null,
    category: "gap",
    type: payload.reason,
    payload,
  } as Event;
}

const exhausted = (lost: number) =>
  gap({ reason: "buffer-exhausted", producer: "hook:d1", fromSeq: 2, toSeq: lost + 1, lost });
const LOST = gap({ reason: "connection-lost", startedAt: NOW, lastSeq: 7 });

test("gap rows count each reason's gaps and lost events, in the protocol's order", () => {
  expect(gapRows([LOST, exhausted(10), exhausted(5)])).toEqual([
    { reason: "buffer-exhausted", label: "An observer's buffer was full", gaps: 2, lostEvents: 15 },
    {
      reason: "connection-lost",
      label: "The connection to Chrome was lost",
      gaps: 1,
      lostEvents: 0,
    },
  ]);
});

test("shows the run's gaps by reason as the collector's, following the cursor", async () => {
  const fake = fakeApi({
    "run.queryEvents": ({ cursor }) =>
      cursor ? { events: [exhausted(5)] } : { events: [exhausted(10), LOST], nextCursor: "next" },
  });
  renderWith(fake.api, <Gaps runId="run-1" />);
  const list = page.getByRole("list", { name: "Collector gaps by reason" });
  await expect.element(list).toBeVisible();
  await expect
    .element(list.getByRole("listitem").first())
    .toHaveTextContent("An observer's buffer was full: 2 gaps, 15 events lost");
  await expect
    .element(list.getByRole("listitem").nth(1))
    .toHaveTextContent("The connection to Chrome was lost: 1 gap");
  await expect.element(page.getByText(/not a failure of the application/)).toBeVisible();
  expect(fake.paramsOf("run.queryEvents")).toEqual([
    { runId: "run-1", category: "gap", limit: 1000 },
    { runId: "run-1", category: "gap", limit: 1000, cursor: "next" },
  ]);
});

test("a run without gaps says nothing was lost", async () => {
  const fake = fakeApi({ "run.queryEvents": () => ({ events: [] }) });
  renderWith(fake.api, <Gaps runId="run-1" />);
  await expect
    .element(page.getByText("The collector reported no gaps: nothing it observes was lost."))
    .toBeVisible();
});
