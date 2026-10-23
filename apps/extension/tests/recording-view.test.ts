import { sampleSnapshot } from "@recnrun/domain/testing";
import { expect, test } from "vite-plus/test";
import { toRecordingViews } from "@/dashboard/recording-view";

test("labels recordings newest first", () => {
  expect(toRecordingViews(sampleSnapshot().recordings)).toEqual([
    {
      id: "rec-checkout",
      name: "Checkout with saved card",
      startUrl: "https://staging.shop.example/cart",
      recordedAt: "2026-10-02 14:05 UTC",
      duration: "1 min 35 s",
      events: "31 events",
    },
    {
      id: "rec-login",
      name: "Log in as admin",
      startUrl: "http://localhost:3000/login",
      recordedAt: "2026-10-01 09:30 UTC",
      duration: "12 s",
      events: "7 events",
    },
  ]);
});

test("uses the singular for one event and keeps the input order untouched", () => {
  const recordings = sampleSnapshot().recordings.map((recording) => ({
    ...recording,
    eventCount: 1,
  }));
  const before = recordings.map((recording) => recording.id);
  expect(toRecordingViews(recordings).map((view) => view.events)).toEqual(["1 event", "1 event"]);
  expect(recordings.map((recording) => recording.id)).toEqual(before);
});
