import { TIMELINE_PORT } from "@/messaging/background-protocol";
import type { TimelineMessage } from "@/messaging/background-protocol";

/** The part of `runtime.Port` the broadcaster uses. */
export interface TimelinePort {
  name: string;
  sender?: { tab?: { groupId?: number } };
  postMessage(message: unknown): void;
  onDisconnect: { addListener(listener: () => void): void };
}

/** Without a group, every port gets the message; with one, only that group's dashboards. */
export type Notify = (message: TimelineMessage, groupId?: number) => void;

export interface TimelinePorts {
  accept: (port: TimelinePort) => void;
  notify: Notify;
}

/** Pushes recorded steps and recording changes to the dashboards that keep a port open. */
export function createTimelinePorts(): TimelinePorts {
  const ports = new Set<TimelinePort>();
  return {
    accept: (port) => {
      if (port.name !== TIMELINE_PORT) return;
      ports.add(port);
      port.onDisconnect.addListener(() => ports.delete(port));
    },
    notify: (message, groupId) => {
      for (const port of ports) {
        if (groupId === undefined || port.sender?.tab?.groupId === groupId)
          port.postMessage(message);
      }
    },
  };
}
