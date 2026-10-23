import { sampleSnapshot } from "@recnrun/domain/testing";
import { expect, test } from "vite-plus/test";
import { recordingPath, selectedRecordingId, titleFor } from "@/dashboard/route";

test("maps recording routes to ids, encoded both ways", () => {
  expect(recordingPath("rec login")).toBe("/recordings/rec%20login");
  expect(selectedRecordingId("/recordings/rec%20login?view=events#t=3")).toBe("rec login");
  expect(selectedRecordingId("/")).toBeUndefined();
  expect(selectedRecordingId("/recordings/")).toBeUndefined();
  expect(selectedRecordingId("/recordings/%E0")).toBeUndefined();
});

test("titles a route after its recording, or the product", () => {
  expect(titleFor(sampleSnapshot(), "/recordings/rec-checkout")).toBe(
    "Checkout with saved card · RECnRun",
  );
  expect(titleFor(sampleSnapshot(), "/recordings/missing")).toBe("RECnRun");
  expect(titleFor(undefined, "/recordings/rec-checkout")).toBe("RECnRun");
  expect(titleFor(sampleSnapshot(), "/")).toBe("RECnRun");
});

test("titles a workspace's list after its site", () => {
  expect(titleFor(sampleSnapshot(), "/", "http://localhost:3000")).toBe("localhost:3000 · RECnRun");
  expect(titleFor(sampleSnapshot(), "/recordings/rec-login", "http://localhost:3000")).toBe(
    "Log in as admin · RECnRun",
  );
});
