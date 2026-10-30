import { sampleStep } from "@recnrun/domain/testing";
import { expect, test, vi } from "vite-plus/test";
import { createTimelinePorts } from "@/background/timeline-ports";
import type { TimelineMessage } from "@/messaging/background-protocol";

function fakePort(name: string, groupId?: number) {
  let disconnect = (): void => {};
  return {
    name,
    sender: groupId === undefined ? undefined : { tab: { groupId } },
    postMessage: vi.fn(),
    onDisconnect: {
      addListener(listener: () => void) {
        disconnect = listener;
      },
    },
    close: () => disconnect(),
  };
}

test("delivers steps to every timeline port and group changes to that group's ports", () => {
  const ports = createTimelinePorts();
  const dashboard = fakePort("timeline", 7);
  const other = fakePort("timeline", 9);
  const unrelated = fakePort("something-else", 7);
  for (const port of [dashboard, other, unrelated]) ports.accept(port);

  const step: TimelineMessage = { name: "stepRecorded", data: sampleStep() };
  ports.notify(step);
  const changed: TimelineMessage = { name: "recordingChanged", data: { missingOrigins: [] } };
  ports.notify(changed, 7);

  expect(dashboard.postMessage.mock.calls).toEqual([[step], [changed]]);
  expect(other.postMessage.mock.calls).toEqual([[step]]);
  expect(unrelated.postMessage).not.toHaveBeenCalled();
});

test("forgets a port once it disconnects", () => {
  const ports = createTimelinePorts();
  const port = fakePort("timeline", 7);
  ports.accept(port);
  port.close();
  ports.notify({ name: "stepRecorded", data: sampleStep() });
  expect(port.postMessage).not.toHaveBeenCalled();
});
