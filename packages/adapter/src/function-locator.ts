import {
  FunctionLocatorRequestSchema,
  type FunctionLocatorRequest,
  type FunctionLocatorResult,
  type LocatorDeadline,
} from "@recnrun/protocol";
import * as v from "valibot";
import type { CdpSession } from "./cdp-link.ts";
import { openCdpChannel, type CdpChannel } from "./cdp-socket.ts";
import { applyCardinality } from "./function-locator-cardinality.ts";
import {
  arrayItems,
  createWorld,
  describeElements,
  EvaluationSchema,
  exceptionText,
  type Evaluation,
  findFrame,
  type FrameInfo,
  type RemoteObject,
} from "./function-locator-cdp.ts";
import { cutAtDeadline, timedOut, within } from "./function-locator-deadline.ts";

/** A page target, reached through a CDP session already attached to it or a browser endpoint. */
export type LocatorTarget =
  | { session: CdpSession; targetId: string }
  | { endpoint: string; targetId: string };

export interface FunctionLocatorOptions {
  /** How long each responsiveness probe and the termination may take; 1000 ms by default. */
  probeTimeoutMs?: number;
  openChannel?: (endpoint: string) => Promise<CdpChannel>;
}

/** A result whose matched handles stay valid until `release()`. */
export type FunctionLocatorResolution = FunctionLocatorResult & { release(): Promise<void> };

type Outcome = Pick<FunctionLocatorResult, "status" | "count" | "elements" | "error" | "deadline">;

interface LocatorRun {
  session: CdpSession;
  targetId: string;
  request: FunctionLocatorRequest;
  objectGroup: string;
  probeMs: number;
  /** Handles a matched result does not hand out; released one by one. */
  transient: string[];
}

// Runs in the isolated world with `this` bound to what the locator returned.
const TO_ELEMENTS = `function () {
  const value = this;
  const list = value instanceof Element ? [value]
    : Array.isArray(value) || value instanceof NodeList || value instanceof HTMLCollection
      ? Array.from(value) : undefined;
  if (!list) throw new TypeError("The locator function returned " + Object.prototype.toString.call(value) + ", not elements.");
  list.forEach((item, index) => {
    if (!(item instanceof Element) || item.ownerDocument !== document || !item.isConnected)
      throw new TypeError("Item " + index + " is not an element connected to the frame's document.");
  });
  return list;
}`;

const DEFAULT_PROBE_MS = 1_000;

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

const failed = (status: "error" | "unsupported", message: string): Outcome => ({
  status,
  count: 0,
  elements: [],
  error: { message },
});

async function callLocator(
  run: LocatorRun,
  contextId: number,
): Promise<{ deadline: LocatorDeadline } | { evaluation: Evaluation }> {
  const { session, request, objectGroup } = run;
  const scope = v.parse(
    EvaluationSchema,
    await session.send("Runtime.evaluate", {
      expression: "({ root: document })",
      contextId,
      objectGroup,
    }),
  ).result.objectId;
  if (scope) run.transient.push(scope);
  const call = session.send("Runtime.callFunctionOn", {
    functionDeclaration: request.source,
    executionContextId: contextId,
    arguments: [{ objectId: scope }, { value: request.args ?? {} }],
    returnByValue: false,
    awaitPromise: true,
    objectGroup,
  });
  // A call cut at the deadline still settles later; its rejection is not the caller's.
  call.catch(() => undefined);
  const reply = await within(call, request.timeoutMs);
  if (timedOut(reply))
    return { deadline: await cutAtDeadline(session, request.timeoutMs, run.probeMs) };
  return { evaluation: v.parse(EvaluationSchema, reply) };
}

/** The handles of the elements a locator returned, or why the value is not elements. */
async function elementHandles(
  run: LocatorRun,
  value: RemoteObject,
): Promise<{ handles: string[] } | { unsupported: string }> {
  if (value.type === "undefined" || value.subtype === "null") return { handles: [] };
  if (value.type !== "object" || !value.objectId)
    return { unsupported: `The locator function returned a ${value.type}, not elements.` };
  run.transient.push(value.objectId);
  const reply = await run.session.send("Runtime.callFunctionOn", {
    functionDeclaration: TO_ELEMENTS,
    objectId: value.objectId,
    returnByValue: false,
    objectGroup: run.objectGroup,
  });
  const { result, exceptionDetails } = v.parse(EvaluationSchema, reply);
  if (exceptionDetails) return { unsupported: exceptionText(exceptionDetails) };
  if (!result.objectId) throw new Error("Chrome returned no handle for the element list.");
  run.transient.push(result.objectId);
  return { handles: await arrayItems(run.session, result.objectId) };
}

async function pick(run: LocatorRun, frame: FrameInfo, handles: string[]): Promise<Outcome> {
  const { references, duplicates } = await describeElements(
    run.session,
    { targetId: run.targetId, frame },
    handles,
  );
  run.transient.push(...duplicates);
  const { cardinality, index } = run.request;
  const picked = applyCardinality(references, cardinality, index);
  for (const each of references)
    if (!picked.selected.includes(each)) run.transient.push(each.objectId);
  return { status: picked.status, count: references.length, elements: picked.selected };
}

async function locate(run: LocatorRun): Promise<Outcome> {
  const frame = await findFrame(run.session, run.request.frameId);
  const called = await callLocator(run, await createWorld(run.session, frame.id));
  if ("deadline" in called) return deadlineOutcome(called.deadline);
  const { result, exceptionDetails } = called.evaluation;
  if (exceptionDetails) return failed("error", exceptionText(exceptionDetails));
  const listed = await elementHandles(run, result);
  if ("unsupported" in listed) return failed("unsupported", listed.unsupported);
  return pick(run, frame, listed.handles);
}

function deadlineOutcome(deadline: LocatorDeadline): Outcome {
  const message = `The locator function did not finish within ${deadline.timeoutMs} ms.`;
  return { ...failed("error", message), deadline };
}

// A renderer still stuck in a loop answers nothing, so no release waits longer than a probe.
async function releasing(
  session: CdpSession,
  probeMs: number,
  commands: [string, Record<string, unknown>][],
): Promise<void> {
  const sent = commands.map(([method, params]) =>
    session.send(method, params).catch(() => undefined),
  );
  await within(Promise.all(sent), probeMs);
}

function releaseTransient(run: LocatorRun, outcome: Outcome): Promise<void> {
  const { session, probeMs, objectGroup, transient } = run;
  if (outcome.status !== "matched")
    return releasing(session, probeMs, [["Runtime.releaseObjectGroup", { objectGroup }]]);
  const each = transient.map((objectId): [string, Record<string, unknown>] => [
    "Runtime.releaseObject",
    { objectId },
  ]);
  return releasing(session, probeMs, each);
}

async function resolveOn(
  session: CdpSession,
  targetId: string,
  request: FunctionLocatorRequest,
  probeMs: number,
): Promise<FunctionLocatorResolution> {
  const started = performance.now();
  const objectGroup = `recnrun-locator-${crypto.randomUUID()}`;
  const run: LocatorRun = { session, targetId, request, objectGroup, probeMs, transient: [] };
  const outcome = await locate(run).catch((error: unknown) => failed("error", reason(error)));
  await releaseTransient(run, outcome);
  const { status, count, elements, ...rest } = outcome;
  return {
    status,
    cardinality: request.cardinality,
    count,
    elements,
    durationMs: performance.now() - started,
    objectGroup,
    ...rest,
    release: () => releasing(session, probeMs, [["Runtime.releaseObjectGroup", { objectGroup }]]),
  };
}

const AttachReplySchema = v.object({ sessionId: v.string() });

async function resolveAtEndpoint(
  { endpoint, targetId }: { endpoint: string; targetId: string },
  request: FunctionLocatorRequest,
  options: FunctionLocatorOptions,
): Promise<FunctionLocatorResolution> {
  const channel = await (options.openChannel ?? openCdpChannel)(endpoint);
  try {
    const attached = await channel.send("Target.attachToTarget", { targetId, flatten: true });
    const { sessionId } = v.parse(AttachReplySchema, attached);
    const session: CdpSession = {
      send: (method, params) => channel.send(method, params, sessionId),
    };
    const resolution = await resolveOn(
      session,
      targetId,
      request,
      options.probeTimeoutMs ?? DEFAULT_PROBE_MS,
    );
    // Handles live only as long as the session; closing the socket detaches it.
    if (resolution.status !== "matched") channel.close();
    return {
      ...resolution,
      release: async () => {
        await resolution.release();
        channel.close();
      },
    };
  } catch (error) {
    channel.close();
    throw error;
  }
}

/**
 * Runs a JavaScript locator function in an isolated world of one frame and converts what it returns
 * (an element, an array or NodeList of elements, or null) into element references under the
 * request's cardinality. Handles other than the matched references are released before it returns.
 */
export function resolveFunctionLocator(
  target: LocatorTarget,
  request: FunctionLocatorRequest,
  options: FunctionLocatorOptions = {},
): Promise<FunctionLocatorResolution> {
  const valid = v.parse(FunctionLocatorRequestSchema, request);
  if ("endpoint" in target) return resolveAtEndpoint(target, valid, options);
  return resolveOn(
    target.session,
    target.targetId,
    valid,
    options.probeTimeoutMs ?? DEFAULT_PROBE_MS,
  );
}
