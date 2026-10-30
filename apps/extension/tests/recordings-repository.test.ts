import { beforeEach, expect, test } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  bindRecording,
  findRecordingGroup,
  readRecordings,
  unbindRecording,
} from "@/storage/recordings-repository";

beforeEach(() => {
  fakeBrowser.reset();
});

test("has no recordings before anything is stored", async () => {
  await expect(readRecordings()).resolves.toEqual(new Map());
});

test("binds a tab group to a workflow and reads it back", async () => {
  await bindRecording(7, { workflowId: "wf-login", dashboardOrigin: "http://localhost:5173" });
  await bindRecording(9, { workflowId: "wf-checkout" });
  await expect(readRecordings()).resolves.toEqual(
    new Map([
      [7, { workflowId: "wf-login", dashboardOrigin: "http://localhost:5173" }],
      [9, { workflowId: "wf-checkout" }],
    ]),
  );
  await expect(findRecordingGroup("wf-checkout")).resolves.toBe(9);
  await expect(findRecordingGroup("wf-missing")).resolves.toBeUndefined();
});

test("unbinds a tab group", async () => {
  await bindRecording(7, { workflowId: "wf-login" });
  await unbindRecording(7);
  await unbindRecording(8);
  await expect(readRecordings()).resolves.toEqual(new Map());
});

test("rejects stored recordings that do not match the current schema", async () => {
  await fakeBrowser.storage.local.set({ recordings: { 7: { workflowId: 42 } } });
  await expect(readRecordings()).rejects.toThrow(/current schema/);
});
