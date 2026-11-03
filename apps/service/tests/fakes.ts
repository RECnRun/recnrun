import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLeaseRegistry } from "@recnrun/engine";
import { openBindingsStore, openFlowStore, type FlowStore } from "@recnrun/persistence";
import type {
  CapturedEvent,
  DiscoveryResult,
  DomTarget,
  LeaseFence,
  ServiceMessage,
} from "@recnrun/protocol";
import { onTestFinished } from "vite-plus/test";
import type { BrowserPort } from "@/browser";
import { createCommands, type CommandDeps } from "@/commands";
import { dispatch, type PushChannel } from "@/dispatch";
import { createEventHub } from "@/hub";
import { createJournalRegistry } from "@/journals";
import type { Logger } from "@/logger";

const CHROME: DiscoveryResult = {
  ok: true,
  wsEndpoint: "ws://127.0.0.1:9222/devtools/browser/fake",
  userDataDir: "/profiles/default",
  source: "active-port-file",
  port: 9222,
  path: "/devtools/browser/fake",
};

/** Chrome as the commands see it: events and picks are fed by the test. */
export interface FakeBrowser extends BrowserPort {
  emit(event: CapturedEvent): void;
  /** Delivers as the recording does and answers what the service answers: the event's journal write. */
  deliver(event: CapturedEvent): void | Promise<void>;
  pickElement(target: DomTarget): void;
  readonly calls: string[];
  found: DiscoveryResult;
}

function fakeBrowser(): FakeBrowser {
  let onEvent: (event: CapturedEvent) => void | Promise<void> = () => {};
  let onPicked: ((target: DomTarget) => void) | undefined;
  const calls: string[] = [];
  const fake: FakeBrowser = {
    calls,
    found: CHROME,
    discover: async (options) => (calls.push(`discover ${options?.userDataDir ?? ""}`), fake.found),
    async record(_endpoint, capture) {
      onEvent = capture.onEvent;
      calls.push("record");
      return { targetId: "page-1", drain: async () => {}, stop: () => calls.push("record.stop") };
    },
    async pick(_endpoint, _targetId, picked) {
      onPicked = picked;
      calls.push("pick");
      return { stop: async () => void calls.push("pick.stop") };
    },
    replayDriver: async () => {
      throw new Error("No replay in this fake.");
    },
    emit: (event) => void onEvent(event),
    deliver: (event) => onEvent(event),
    pickElement: (target) => onPicked?.(target),
  };
  return fake;
}

const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {}, close: async () => {} };

export interface Harness {
  deps: CommandDeps;
  browser: FakeBrowser;
  flows: FlowStore;
  home: string;
  /** Every message the hub published. */
  published: ServiceMessage[];
  /** Moves the lease clock forward, so leases can expire. */
  advance(ms: number): void;
  call(
    command: string,
    params: unknown,
    extra?: { lease?: LeaseFence; channel?: PushChannel },
  ): Promise<unknown>;
}

/** The session, flow, and run commands over a temporary home and a fake Chrome. */
export async function harness(): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), "recnrun-service-"));
  const flows = await openFlowStore({ home });
  const browser = fakeBrowser();
  const hub = createEventHub();
  const published: ServiceMessage[] = [];
  hub.subscribe({}, (message) => published.push(message));
  let clock = Date.parse("2026-11-03T10:00:00.000Z");
  const deps: CommandDeps = {
    home,
    browser,
    hub,
    logger: quiet,
    journals: createJournalRegistry(),
    bindings: openBindingsStore({ home }),
    leases: createLeaseRegistry({
      now: () => clock,
      ttlMs: 6e4,
    }),
    now: () => (clock += 10),
    sessions: new Map(),
    store: () => flows,
    runs: new Map(),
    active: new Set(),
  };
  const handlers = createCommands(deps);
  onTestFinished(async () => {
    await Promise.allSettled(deps.active);
    flows.close();
    await rm(home, { recursive: true, force: true });
  });
  const call: Harness["call"] = async (command, params, extra = {}) => {
    const { lease, channel } = extra;
    const envelope = { requestId: "r-1", command, params, ...(lease && { lease }) };
    return dispatch(envelope, handlers, channel);
  };
  const advance = (ms: number) => void (clock += ms);
  return { deps, browser, flows, home, published, advance, call };
}

/** A DOM event as the page hook reports it. */
function domEvent(
  seq: number,
  type: string,
  target: DomTarget,
  extra: Record<string, unknown> = {},
): CapturedEvent {
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

const NAME: DomTarget = {
  tag: "input",
  id: "name",
  testId: "name",
  name: "name",
  inputType: "text",
};
const SEND: DomTarget = { tag: "button", id: "send", testId: "send" };

const POINTER = { x: 1, y: 1, button: 0, pointerType: "mouse", modifiers: [] };

/** A person types "Ada" in the name field and clicks Send. */
export function fillAndClick(start: number): CapturedEvent[] {
  const typed = { inputType: "insertText", data: "Ada", isComposing: false, value: "Ada" };
  return [
    domEvent(start, "focusin", NAME),
    domEvent(start + 1, "input", NAME, typed),
    domEvent(start + 2, "change", NAME, { value: "Ada" }),
    domEvent(start + 3, "focusout", NAME),
    domEvent(start + 4, "pointerdown", SEND, POINTER),
    domEvent(start + 5, "pointerup", SEND, POINTER),
    domEvent(start + 6, "click", SEND, { ...POINTER, detail: 1 }),
  ];
}

export const SEND_BUTTON = SEND;

/** The session's page commits a navigation to `url`. */
export function navigated(seq: number, url: string): CapturedEvent {
  return {
    ...domEvent(seq, "committed", SEND),
    category: "navigation",
    payload: { url },
  } as CapturedEvent;
}
