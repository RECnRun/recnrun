import { expect, test, vi } from "vite-plus/test";
import { agentPorts, chromeAgentPorts, routeAgentPorts } from "@/background/workspace/agent-ports";
import type { OriginPort } from "@/messaging/origin-protocol";
import { fakePort } from "./fake-port";

const SENDER = { tab: { id: 7 }, frameId: 0, documentId: "doc-7", origin: "https://app.example" };

test("ends at once a link no listener keeps, even with no listener at all", () => {
  const { dispatch } = agentPorts();
  const stray = fakePort(SENDER);
  dispatch(stray);
  expect(stray.disconnected).toBe(true);
});

test("hands a link to every listener in turn and leaves open one that any of them keeps", () => {
  const { event, dispatch } = agentPorts();
  const heard: string[] = [];
  event.addListener(() => Boolean(heard.push("first")) && false);
  event.addListener(() => Boolean(heard.push("keeper")));
  event.addListener(() => Boolean(heard.push("last")) && false);
  const kept = fakePort(SENDER);
  dispatch(kept);
  expect(heard).toEqual(["first", "keeper", "last"]);
  expect(kept.disconnected).toBe(false);
});

test("a listener that removes itself or adds another while a link is handed on keeps Chrome's order", () => {
  const { event, dispatch, listeners } = agentPorts();
  const later = vi.fn(() => true);
  const once = () => {
    event.removeListener(once);
    event.addListener(later);
    return true;
  };
  event.addListener(once);
  dispatch(fakePort(SENDER));
  expect(later).not.toHaveBeenCalled();
  expect([...listeners]).toEqual([later]);
});

test("leaves ports other than an agent's to their own listeners", () => {
  const { dispatch } = agentPorts();
  const other = fakePort(SENDER);
  other.name = "another-port";
  dispatch(other);
  expect(other.disconnected).toBe(false);
});

test("routes Chrome's links to the waits listening on the background's agent links", () => {
  const listeners: ((port: OriginPort) => void)[] = [];
  routeAgentPorts({ addListener: (listener) => listeners.push(listener) });
  const keep = vi.fn(() => true);
  chromeAgentPorts.addListener(keep);
  const link = fakePort(SENDER);
  for (const listener of listeners) listener(link);
  chromeAgentPorts.removeListener(keep);
  expect(keep).toHaveBeenCalledWith(link);
  expect(link.disconnected).toBe(false);
});
