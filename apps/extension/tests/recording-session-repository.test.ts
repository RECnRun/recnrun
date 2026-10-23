import { beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { recordingSessionRepository } from "@/storage/recording-session-repository";

beforeEach(() => {
  fakeBrowser.reset();
});

test("stores, announces, and clears the recording in progress", async () => {
  const changed = vi.fn();
  const unwatch = recordingSessionRepository.watch(changed);
  expect(await recordingSessionRepository.read()).toBeNull();

  const session = { status: "recording" as const, banked: 0, since: 1_000 };
  await recordingSessionRepository.write(session);
  expect(await recordingSessionRepository.read()).toEqual(session);
  await expect.poll(() => changed.mock.calls.length).toBe(1);

  await recordingSessionRepository.write(null);
  expect(await recordingSessionRepository.read()).toBeNull();
  unwatch();
});

test("rejects a stored recording that does not match the schema", async () => {
  await fakeBrowser.storage.session.set({ recording: { status: "idle" } });
  await expect(recordingSessionRepository.read()).rejects.toThrow(
    "The stored recording does not match the current schema.",
  );
});
