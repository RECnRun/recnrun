import type { BrowserPort } from "../../apps/service/src/index.ts";
import type { ReplayDriver } from "../../packages/engine/src/index.ts";
import type {
  CapturedEvent,
  DiscoveryResult,
  DomTarget,
} from "../../packages/protocol/src/index.ts";

const FOUND: DiscoveryResult = {
  ok: true,
  wsEndpoint: "ws://127.0.0.1:9222/devtools/browser/fake",
  userDataDir: "/profiles/default",
  source: "active-port-file",
  port: 9222,
  path: "/devtools/browser/fake",
};

/** Chrome for the contract tests: the test feeds captured events and picks, and opens the replay. */
export interface FakeChrome {
  adapter: BrowserPort;
  emit(event: CapturedEvent): void;
  pick(target: DomTarget): void;
  /** Lets the replay's writes through; until then each one waits. */
  release(): void;
  readonly writes: string[];
  /** What the service ended, in order: `record.stop`, `replay.close`, and `close`. */
  readonly calls: string[];
}

function driver(gate: Promise<void>, writes: string[]): ReplayDriver {
  return {
    inspect: async () => ({
      count: 1,
      visible: true,
      enabled: true,
      editable: true,
      text: "",
      value: "Ada",
    }),
    readAttribute: async () => null,
    tabs: async () => ({ tabs: [{ url: "http://127.0.0.1:4600/", title: "" }], current: 0 }),
    act: async (command) => {
      writes.push(command.kind);
      await gate;
      return { status: "done" };
    },
  };
}

export function fakeChrome(): FakeChrome {
  let onEvent: (event: CapturedEvent) => void | Promise<void> = () => {};
  let onPicked: (target: DomTarget) => void = () => {};
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const writes: string[] = [];
  const calls: string[] = [];
  const adapter: BrowserPort = {
    discover: async () => FOUND,
    record: async (_endpoint, capture) => {
      onEvent = capture.onEvent;
      return {
        targetId: "page-1",
        drain: async () => {},
        stop: () => void calls.push("record.stop"),
      };
    },
    pick: async (_endpoint, _targetId, picked) => {
      onPicked = picked;
      return { stop: async () => {} };
    },
    replayDriver: async () => ({
      driver: driver(gate, writes),
      close: async () => void calls.push("replay.close"),
    }),
    close: async () => void calls.push("close"),
  };
  return {
    adapter,
    emit: (event) => void onEvent(event),
    pick: (target) => onPicked(target),
    release: () => release(),
    writes,
    calls,
  };
}

const NAME: DomTarget = {
  tag: "input",
  id: "name",
  testId: "name",
  name: "name",
  inputType: "text",
};
const SEND: DomTarget = { tag: "button", id: "send", testId: "send" };
export const SEND_TARGET = SEND;

function dom(seq: number, type: string, target: DomTarget, extra: object = {}): CapturedEvent {
  return {
    schemaVersion: 1,
    id: `cdp:S1#${seq}`,
    runId: "rec-1",
    seq,
    source: "S1",
    producer: "cdp:S1",
    timestamp: new Date(Date.parse("2026-11-03T10:00:00.000Z") + seq).toISOString(),
    component: "application",
    targetId: "page-1",
    frameId: "page-1",
    documentId: "D1",
    category: "dom",
    type,
    payload: { target, isTrusted: true, ...extra },
  } as CapturedEvent;
}

/** What the page hook reports when a person types "Ada" in the name field and clicks Send. */
export function typedAndSent(): CapturedEvent[] {
  const pointer = { x: 1, y: 1, button: 0, pointerType: "mouse", modifiers: [] };
  return [
    dom(1, "focusin", NAME),
    dom(2, "input", NAME, {
      inputType: "insertText",
      data: "Ada",
      isComposing: false,
      value: "Ada",
    }),
    dom(3, "change", NAME, { value: "Ada" }),
    dom(4, "focusout", NAME),
    dom(5, "pointerdown", SEND, pointer),
    dom(6, "pointerup", SEND, pointer),
    dom(7, "click", SEND, { ...pointer, detail: 1 }),
  ];
}
