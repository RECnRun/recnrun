import type { FunctionLocatorRequest } from "@recnrun/protocol";
import type { CdpSession } from "../src/cdp-link.ts";
import { FakeChannel } from "./fake-channel.ts";

type Params = Record<string, unknown> | undefined;
type Responder = (params: Params) => unknown;

export const NEVER = new Promise<never>(() => undefined);

/** The fake channel with scripted replies per method; an unscripted method answers `{}`. */
export class ScriptedChannel extends FakeChannel {
  readonly replies = new Map<string, Responder>();

  override send(method: string, params?: Params, sessionId?: string): Promise<unknown> {
    const sent = super.send(method, params, sessionId);
    if (this.failing.has(method)) return sent;
    const reply = this.replies.get(method)?.(params) ?? {};
    return reply instanceof Promise ? reply : Promise.resolve(reply);
  }

  sentOf(method: string) {
    return this.sent.filter((each) => each.method === method);
  }
}

export const object = (objectId: string, subtype?: string) => ({
  result: { type: "object", objectId, ...(subtype && { subtype }) },
});

/** A page whose locator returns `value`, whose list holds `items`, and whose nodes map by handle. */
export function page(value: unknown, items: string[] = [], nodes: Record<string, number> = {}) {
  const channel = new ScriptedChannel();
  channel.replies.set("Page.getFrameTree", () => ({
    frameTree: {
      frame: { id: "F1", loaderId: "L1" },
      childFrames: [{ frame: { id: "F2", loaderId: "L2" } }],
    },
  }));
  channel.replies.set("Page.createIsolatedWorld", () => ({ executionContextId: 7 }));
  channel.replies.set("Runtime.evaluate", (params) =>
    params?.expression === "1+1" ? { result: { type: "number", value: 2 } } : object("scope"),
  );
  channel.replies.set("Runtime.callFunctionOn", (params) =>
    params?.objectId === undefined ? value : object("list", "array"),
  );
  channel.replies.set("Runtime.getProperties", () => ({
    result: [
      ...items.map((objectId, index) => ({
        name: String(index),
        value: { type: "object", objectId },
      })),
      { name: "length", value: { type: "number", value: items.length } },
    ],
  }));
  channel.replies.set("DOM.describeNode", (params) => ({
    node: { backendNodeId: nodes[String(params?.objectId)] ?? 1 },
  }));
  const session: CdpSession = { send: (method, params) => channel.send(method, params, "S1") };
  return { channel, target: { session, targetId: "T1" } };
}

export const request = (
  overrides: Partial<FunctionLocatorRequest> = {},
): FunctionLocatorRequest => ({
  source: "({ root }) => root.querySelectorAll('li')",
  cardinality: "one",
  timeoutMs: 1_000,
  ...overrides,
});

export const released = (channel: ScriptedChannel) =>
  channel.sentOf("Runtime.releaseObject").map(({ params }) => params?.objectId);

/** A renderer that misses the first probe, as one stuck in a loop does, and answers after termination. */
export function blockedOnce(channel: ScriptedChannel): void {
  let probes = 0;
  channel.replies.set("Runtime.evaluate", (params) => {
    if (params?.expression !== "1+1") return object("scope");
    probes += 1;
    return probes === 1 ? NEVER : { result: { type: "number", value: 2 } };
  });
}
