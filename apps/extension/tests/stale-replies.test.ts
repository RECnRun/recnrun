import { expect, test, vi } from "vite-plus/test";
import { replayStaleReplies } from "@/background/stale-replies";
import { ORIGIN_AGENT_PORT } from "@/messaging/origin-protocol";
import type { OriginPort } from "@/messaging/origin-protocol";

function fakeEvent<A extends unknown[]>() {
  const listeners = new Set<(...args: A) => void>();
  return {
    listeners,
    addListener: (listener: (...args: A) => void) => {
      listeners.add(listener);
    },
    removeListener: (listener: (...args: A) => void) => {
      listeners.delete(listener);
    },
    fire: (...args: A) => {
      for (const listener of listeners) listener(...args);
    },
  };
}

function fakePort(name = ORIGIN_AGENT_PORT) {
  return {
    name,
    sender: { tab: { id: 7 }, frameId: 0 },
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: fakeEvent<[unknown]>(),
    onDisconnect: fakeEvent<[]>(),
  };
}

/** The ports the background's listener received, in order. */
function setUp() {
  const onConnect = fakeEvent<[OriginPort]>();
  const stale = replayStaleReplies(onConnect);
  const received: OriginPort[] = [];
  const listener = (port: OriginPort) => received.push(port);
  onConnect.addListener(listener);
  return { onConnect, stale, received, listener };
}

/** Opens a link, listens on it as the background does, and sends `command`. */
function exchange(setup: ReturnType<typeof setUp>, command: object) {
  const port = fakePort();
  setup.onConnect.fire(port);
  const link = setup.received.at(-1);
  if (!link) throw new Error("No link received.");
  const heard: unknown[] = [];
  link.onMessage.addListener((message) => heard.push(message));
  link.postMessage(command);
  return { port, link, heard };
}

const CAPTURED = { type: "captured", operationId: "op-1", generation: 3, counts: { records: 2 } };

test("while off, each link reaches the background as Chrome opened it", () => {
  const { onConnect, received, listener } = setUp();
  const port = fakePort();
  onConnect.fire(port);
  expect(received).toEqual([port]);
  expect(received[0]).toBe(port);
  onConnect.removeListener(listener);
  expect(onConnect.listeners.size).toBe(0);
});

test("when on, a link hears an earlier operation's replies first, as sent and a generation older", async () => {
  const setup = setUp();
  setup.stale.setActive(true);
  const first = exchange(setup, { type: "capture", operationId: "op-1", generation: 3 });
  expect(first.port.postMessage).toHaveBeenCalledWith({
    type: "capture",
    operationId: "op-1",
    generation: 3,
  });
  first.port.onMessage.fire("not a reply");
  first.port.onMessage.fire(CAPTURED);
  await Promise.resolve();
  expect(first.heard).toEqual(["not a reply", CAPTURED]);
  expect(setup.stale.delivered()).toBe(0);

  const second = exchange(setup, { type: "probe", operationId: "op-2", generation: 4 });
  expect(second.heard).toEqual([]);
  await Promise.resolve();
  expect(second.heard).toEqual([CAPTURED, { ...CAPTURED, operationId: "op-2", generation: 3 }]);
  expect(setup.stale.delivered()).toBe(2);
  expect(second.link).toMatchObject({ name: ORIGIN_AGENT_PORT, sender: second.port.sender });
});

test("a link of generation 0 hears the replay a generation newer, and passes the rest through", async () => {
  const setup = setUp();
  setup.stale.setActive(true);
  exchange(setup, CAPTURED).port.onMessage.fire(CAPTURED);
  const { port, link, heard } = exchange(setup, {
    type: "probe",
    operationId: "op-2",
    generation: 0,
  });
  await Promise.resolve();
  expect(heard.at(-1)).toMatchObject({ operationId: "op-2", generation: 1 });
  const quiet = vi.fn();
  link.onMessage.addListener(quiet);
  expect(port.onMessage.listeners.size).toBe(2);
  link.onMessage.removeListener(quiet);
  expect(port.onMessage.listeners.size).toBe(1);
  link.disconnect();
  expect(port.disconnect).toHaveBeenCalledOnce();
  expect(link.onDisconnect).toBe(port.onDisconnect);
});

test("a link of another name is never wrapped", () => {
  const { onConnect, stale, received } = setUp();
  stale.setActive(true);
  const port = fakePort("site");
  onConnect.fire(port);
  expect(received[0]).toBe(port);
});
