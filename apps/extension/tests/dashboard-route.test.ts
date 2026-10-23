import { sampleSnapshot } from "@recnrun/domain/testing";
import { expect, test } from "vite-plus/test";
import { initialRoute, recordingPath, selectedRecordingId, titleFor } from "@/dashboard/route";

test("reads the site route passed by the content script", () => {
  expect(initialRoute("?route=%2Frecordings%2Frec-login%3Fview%3Devents")).toBe(
    "/recordings/rec-login?view=events",
  );
  expect(initialRoute("")).toBe("/");
  expect(initialRoute("?route=https%3A%2F%2Fevil.example")).toBe("/");
});

test("maps recording routes to ids and titles", () => {
  expect(recordingPath("rec login")).toBe("/recordings/rec%20login");
  expect(selectedRecordingId("/recordings/rec%20login?x=1")).toBe("rec login");
  expect(selectedRecordingId("/")).toBeUndefined();
  expect(titleFor(sampleSnapshot(), "/recordings/rec-checkout")).toBe(
    "Checkout with saved card · RECnRun",
  );
  expect(titleFor(undefined, "/recordings/rec-checkout")).toBe("RECnRun");
});
