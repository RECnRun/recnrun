import type { ServiceMessage } from "@recnrun/protocol";
import { expect, test } from "vite-plus/test";
import { createEventHub } from "@/hub";

const status = {
  sessionId: "s-1",
  state: "recording",
  control: "manual",
  pauses: { pauseStepCreation: "active", pauseReplay: "active", suspendCapture: "active" },
} as const;
const ofSession = (sessionId: string): ServiceMessage => ({
  type: "session.status",
  sessionId,
  status: { ...status, sessionId },
});
const picked = (sessionId: string): ServiceMessage => ({
  type: "picker.picked",
  sessionId,
  target: { tag: "button" },
  locators: { resolution: "orderedFallback", cardinality: "one", locators: [{ css: "button" }] },
});

test("delivers a session's messages to its subscribers only", () => {
  const hub = createEventHub();
  const first: ServiceMessage[] = [];
  const all: ServiceMessage[] = [];
  hub.subscribe({ sessionId: "s-1" }, (m) => first.push(m));
  hub.subscribe({}, (m) => all.push(m));
  hub.publish(ofSession("s-1"));
  hub.publish(picked("s-2"));
  expect(first).toEqual([ofSession("s-1")]);
  expect(all).toEqual([ofSession("s-1"), picked("s-2")]);
});

test("a run subscriber never receives session messages, and unsubscribing stops delivery", () => {
  const hub = createEventHub();
  const received: ServiceMessage[] = [];
  const stop = hub.subscribe({ runId: "r-1" }, (m) => received.push(m));
  hub.publish(ofSession("s-1"));
  expect(hub.size).toBe(1);
  stop();
  expect(hub.size).toBe(0);
  hub.publish(ofSession("s-1"));
  expect(received).toEqual([]);
});
