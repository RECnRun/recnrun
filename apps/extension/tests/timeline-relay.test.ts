import { sampleStep } from "@recnrun/domain/testing";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { createTimelineRelay } from "@/content/timeline";

function fakePort() {
  let onMessage = (_message: unknown): void => {};
  let onDisconnect = (): void => {};
  return {
    onMessage: {
      addListener(listener: (message: unknown) => void) {
        onMessage = listener;
      },
    },
    onDisconnect: {
      addListener(listener: () => void) {
        onDisconnect = listener;
      },
    },
    receive: (message: unknown) => onMessage(message),
    drop: () => onDisconnect(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("relays validated timeline messages to the page as bridge events", () => {
  const port = fakePort();
  const emit = vi.fn();
  createTimelineRelay(() => port, emit, 1000);
  port.receive({ name: "stepRecorded", data: sampleStep() });
  port.receive({ name: "recordingChanged", data: { missingOrigins: ["http://localhost/*"] } });
  port.receive({ name: "stepRecorded", data: { id: "broken" } });
  port.receive("junk");
  expect(emit.mock.calls).toEqual([
    ["stepRecorded", sampleStep()],
    ["recordingChanged", { missingOrigins: ["http://localhost/*"] }],
  ]);
});

test("reconnects after the background drops the port, until stopped", () => {
  const ports = [fakePort(), fakePort(), fakePort()];
  const connect = vi.fn(() => ports[connect.mock.calls.length - 1] ?? fakePort());
  const emit = vi.fn();
  const stop = createTimelineRelay(connect, emit, 1000);
  expect(connect).toHaveBeenCalledTimes(1);

  ports[0]?.drop();
  vi.advanceTimersByTime(999);
  expect(connect).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  expect(connect).toHaveBeenCalledTimes(2);
  ports[1]?.receive({ name: "stepRecorded", data: sampleStep() });
  expect(emit).toHaveBeenCalledTimes(1);

  stop();
  ports[1]?.drop();
  vi.advanceTimersByTime(5000);
  expect(connect).toHaveBeenCalledTimes(2);
});
