import {
  MAX_OBSERVER_MESSAGE_LENGTH,
  ObserverMessageSchema,
  type InstrumentedTarget,
  type ObserverMessage,
} from "@recnrun/protocol";
import * as v from "valibot";

/** What the instrumentation keeps about one attached target. */
export interface TargetRecord {
  readonly info: InstrumentedTarget;
  readonly sessionId: string;
  /** Execution context id to its frame id (null in a worker), as `Runtime.executionContextCreated` said. */
  readonly contexts: Map<number, string | null>;
  /** The adapter's sequence for events from this target. */
  seq: number;
}

export type Verdict =
  | { ok: true; message: ObserverMessage; frameId: string | null }
  | { ok: false; reason: "invalid" | "unknown-frame" };

export const AttachedSchema = v.object({
  sessionId: v.string(),
  targetInfo: v.object({ targetId: v.string(), type: v.string(), url: v.string() }),
  waitingForDebugger: v.boolean(),
});

const ContextCreatedSchema = v.object({
  context: v.object({
    id: v.number(),
    auxData: v.optional(v.object({ frameId: v.optional(v.string()) })),
  }),
});

const ContextDestroyedSchema = v.object({ executionContextId: v.number() });

export const BindingCalledSchema = v.object({
  name: v.string(),
  payload: v.string(),
  executionContextId: v.number(),
});

export const DetachedSchema = v.object({ sessionId: v.string() });

export function newRecord(
  sessionId: string,
  info: Pick<InstrumentedTarget, "targetId" | "type" | "url" | "installMode">,
): TargetRecord {
  return {
    sessionId,
    contexts: new Map(),
    seq: 0,
    info: {
      ...info,
      sessionId,
      hookInstalled: false,
      hookInstalls: 0,
      droppedInvalid: 0,
      droppedUnknownFrame: 0,
      detached: false,
    },
  };
}

/** Tracks the execution contexts of a target, so a message can be tied to its frame. */
export function trackContext(record: TargetRecord, method: string, params: unknown): void {
  if (method === "Runtime.executionContextsCleared") {
    record.contexts.clear();
    return;
  }
  if (method === "Runtime.executionContextCreated") {
    const created = v.safeParse(ContextCreatedSchema, params);
    if (created.success) {
      const { id, auxData } = created.output.context;
      record.contexts.set(id, auxData?.frameId ?? null);
    }
    return;
  }
  const destroyed = v.safeParse(ContextDestroyedSchema, params);
  if (destroyed.success) record.contexts.delete(destroyed.output.executionContextId);
}

function parse(payload: string): ObserverMessage | undefined {
  if (payload.length > MAX_OBSERVER_MESSAGE_LENGTH) return undefined;
  try {
    const parsed = v.safeParse(ObserverMessageSchema, JSON.parse(payload));
    return parsed.success ? parsed.output : undefined;
  } catch {
    return undefined;
  }
}

/** Validates a binding message and checks it against the target and context CDP delivered it from. */
export function judge(record: TargetRecord, payload: string, contextId: number): Verdict {
  const message = parse(payload);
  if (!message) {
    record.info.droppedInvalid += 1;
    return { ok: false, reason: "invalid" };
  }
  const frameId = record.contexts.get(contextId);
  if (frameId === undefined || message.targetId !== record.info.targetId) {
    record.info.droppedUnknownFrame += 1;
    return { ok: false, reason: "unknown-frame" };
  }
  return { ok: true, message, frameId };
}
