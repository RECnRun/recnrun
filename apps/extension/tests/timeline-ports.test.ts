import { sampleStep } from "@recnrun/domain/testing";
import { expect, test, vi } from "vite-plus/test";
import { createTimelinePorts } from "@/background/timeline-ports";
import type { TimelineMessage } from "@/messaging/background-protocol";

/** Tab ids map to the group each tab is in now; a port only remembers its tab id. */
const groups = new Map<number, number>();
const currentGroup = async (tabId: number) => groups.get(tabId) ?? -1;

function fakePort(name: string, tabId?: number) {
  let disconnect = (): void => {};
  return {
    name,
    sender: tabId === undefined ? undefined : { tab: { id: tabId } },
    postMessage: vi.fn(),
    onDisconnect: {
      addListener(listener: () => void) {
        disconnect = listener;
      },
    },
    close: () => disconnect(),
  };
}

test("delivers steps to every timeline port and group changes to that group's ports", async () => {
  const ports = createTimelinePorts(currentGroup);
  groups.set(1, 7).set(2, 9);
  const dashboard = fakePort("timeline", 1);
  const other = fakePort("timeline", 2);
  const unrelated = fakePort("something-else", 1);
  for (const port of [dashboard, other, unrelated]) ports.accept(port);

  const step: TimelineMessage = { name: "stepRecorded", data: sampleStep() };
  ports.notify(step);
  const changed: TimelineMessage = { name: "recordingChanged", data: { missingOrigins: [] } };
  ports.notify(changed, 7);

  await vi.waitFor(() => expect(dashboard.postMessage.mock.calls).toEqual([[step], [changed]]));
  expect(other.postMessage.mock.calls).toEqual([[step]]);
  expect(unrelated.postMessage).not.toHaveBeenCalled();
});

test("reaches a dashboard that joined the group after it connected", async () => {
  const ports = createTimelinePorts(currentGroup);
  groups.set(3, -1);
  const dashboard = fakePort("timeline", 3);
  ports.accept(dashboard);
  groups.set(3, 7);
  const changed: TimelineMessage = { name: "recordingChanged", data: { missingOrigins: [] } };
  ports.notify(changed, 7);
  await vi.waitFor(() => expect(dashboard.postMessage).toHaveBeenCalledWith(changed));
});

test("forgets a port once it disconnects", () => {
  const ports = createTimelinePorts(currentGroup);
  const port = fakePort("timeline", 1);
  ports.accept(port);
  port.close();
  ports.notify({ name: "stepRecorded", data: sampleStep() });
  expect(port.postMessage).not.toHaveBeenCalled();
});
