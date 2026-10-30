import { TIMELINE_PORT } from "@/messaging/background-protocol";
import type { TimelineMessage } from "@/messaging/background-protocol";

/** The part of `runtime.Port` the broadcaster uses. */
export interface TimelinePort {
  name: string;
  sender?: { tab?: { id?: number } };
  postMessage(message: unknown): void;
  onDisconnect: { addListener(listener: () => void): void };
}

/** Without a group, every port gets the message; with one, only that group's dashboards. */
export type Notify = (message: TimelineMessage, groupId?: number) => void;

/** The group a tab is in right now; the sender's snapshot is stale once the tab is grouped. */
export type CurrentGroup = (tabId: number) => Promise<number>;

export interface TimelinePorts {
  accept: (port: TimelinePort) => void;
  notify: Notify;
}

/** Pushes recorded steps and recording changes to the dashboards that keep a port open. */
export function createTimelinePorts(currentGroup: CurrentGroup): TimelinePorts {
  const ports = new Set<TimelinePort>();
  const inGroup = async (port: TimelinePort, groupId: number): Promise<boolean> => {
    const tabId = port.sender?.tab?.id;
    return tabId !== undefined && (await currentGroup(tabId).catch(() => undefined)) === groupId;
  };
  return {
    accept: (port) => {
      if (port.name !== TIMELINE_PORT) return;
      ports.add(port);
      port.onDisconnect.addListener(() => ports.delete(port));
    },
    notify: (message, groupId) => {
      for (const port of ports) {
        if (groupId === undefined) {
          port.postMessage(message);
          continue;
        }
        void inGroup(port, groupId).then((member) => {
          if (member && ports.has(port)) port.postMessage(message);
        });
      }
    },
  };
}
