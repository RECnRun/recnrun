import type { OriginData } from "@recnrun/domain";
import * as v from "valibot";
import type { BarrierOperation } from "@/background/workspace/barrier";
import { WorkspaceError } from "@/background/workspace/errors";
import { ORIGIN_AGENT_PORT, OriginReplySchema } from "@/messaging/origin-protocol";
import type {
  CapturedPage,
  OriginPort,
  OriginReply,
  RestoredCounts,
  StorageScope,
} from "@/messaging/origin-protocol";

/** The one document an operation restores into: the barrier's tab, as Chrome committed it. */
export interface AgentExpectation {
  tabId: number;
  documentId: string;
  origin: string;
}

/**
 * The agent is registered for the whole origin, so it also connects from other tabs and frames;
 * only the top frame of the committed document in the managed tab gets the payload.
 */
export function isExpectedAgent(port: OriginPort, expected: AgentExpectation): boolean {
  const sender = port.sender;
  return (
    port.name === ORIGIN_AGENT_PORT &&
    sender?.tab?.id === expected.tabId &&
    sender.frameId === 0 &&
    sender.documentId === expected.documentId &&
    sender.origin === expected.origin
  );
}

function replyTo(message: unknown, operation: BarrierOperation): OriginReply | undefined {
  const reply = v.safeParse(OriginReplySchema, message);
  if (!reply.success) return undefined;
  const { operationId, generation } = reply.output;
  return operationId === operation.id && generation === operation.generation
    ? reply.output
    : undefined;
}

interface Settle<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

/** One command to the agent and the replies it waits for. */
interface Exchange<T> {
  command: { type: string } & Record<string, unknown>;
  boundMs: number;
  /** Restarts the bound at each reply, for an exchange of many messages. */
  idle: boolean;
  onReply: (reply: OriginReply, settle: Settle<T>) => void;
  late: () => WorkspaceError;
  gone: () => WorkspaceError;
}

/** Sends one command and settles on the replies of its own operation, a disconnect, or the bound. */
function exchange<T>(port: OriginPort, operation: BarrierOperation, talk: Exchange<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let open = true;
    const end = (finish: () => void) => {
      if (!open) return;
      open = false;
      clearTimeout(timer);
      try {
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener(onGone);
      } catch {
        // A port whose page is gone has no listener left to remove.
      }
      finish();
    };
    const settle: Settle<T> = {
      resolve: (value) => end(() => resolve(value)),
      reject: (error) => end(() => reject(error)),
    };
    const onLate = () => {
      port.disconnect();
      settle.reject(talk.late());
    };
    let timer = setTimeout(onLate, talk.boundMs);
    const onMessage = (message: unknown) => {
      const reply = replyTo(message, operation);
      if (!reply) return;
      if (talk.idle) {
        clearTimeout(timer);
        timer = setTimeout(onLate, talk.boundMs);
      }
      talk.onReply(reply, settle);
    };
    const onGone = () => settle.reject(talk.gone());
    const { id: operationId, generation } = operation;
    // Chrome throws, rather than fires onDisconnect, when the page went before this port was used.
    try {
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onGone);
      port.postMessage({ ...talk.command, operationId, generation });
    } catch {
      onGone();
    }
  });
}

function failedWith(reply: OriginReply, settle: Settle<never>, what: Ending["what"]): void {
  if (reply.type !== "failed") return;
  const failure = reply.error;
  const name = what === "capture" ? "CaptureFailed" : "RestoreFailed";
  settle.reject(new WorkspaceError(name, `The page could not ${what} its data (${failure}).`));
}

/** What an operation does, and how its exchanges end when the page fails, goes quiet, or goes. */
interface Ending extends Pick<Exchange<unknown>, "late" | "gone"> {
  what: "restore" | "capture";
}

/**
 * Sends a `Date` and waits for the agent's echo before any payload goes either way. Without
 * structured clone, Chrome sends JSON: Dates come back as strings, Blobs as `{}`, silently.
 */
function probeLink(
  port: OriginPort,
  operation: BarrierOperation,
  boundMs: number,
  { what, late, gone }: Ending,
): Promise<void> {
  return exchange<void>(port, operation, {
    command: { type: "probe", probe: new Date(0) },
    boundMs,
    idle: false,
    onReply: (reply, settle) => {
      if (reply.type !== "probe-echo") return failedWith(reply, settle, what);
      if (reply.probe instanceof Date) return settle.resolve();
      settle.reject(
        new WorkspaceError(
          "StructuredCloneUnavailable",
          "Chrome did not keep the page's values intact; this build lacks structured clone messaging.",
        ),
      );
    },
    late,
    gone,
  });
}

const RESTORE_ENDING: Ending = {
  what: "restore",
  late: () => new WorkspaceError("RestoreTimedOut", "The page did not restore its data in time."),
  gone: () =>
    new WorkspaceError("AgentDisconnected", "The page closed before its data was restored."),
};

/**
 * Probes a validated agent, sends it the payload, and waits, at most `boundMs`, for its answer;
 * a session scope has the agent write its tab's sessionStorage alone.
 */
export async function restoreThroughAgent(
  port: OriginPort,
  operation: BarrierOperation,
  payload: OriginData,
  { boundMs, scope = "origin" }: { boundMs: number; scope?: StorageScope },
): Promise<RestoredCounts> {
  await probeLink(port, operation, boundMs, RESTORE_ENDING);
  return exchange<RestoredCounts>(port, operation, {
    command: { type: "restore", scope, payload },
    boundMs,
    idle: false,
    onReply: (reply, settle) => {
      if (reply.type === "restored") settle.resolve(reply.counts);
      else failedWith(reply, settle, "restore");
    },
    late: RESTORE_ENDING.late,
    gone: RESTORE_ENDING.gone,
  });
}

/** Receives a capture's messages as the agent reads them. */
export interface CaptureReceiver {
  storage: (entries: Pick<OriginData, "localStorage" | "sessionStorage">) => void;
  database: (database: OriginData["indexedDB"][number]) => void;
  records: (part: Extract<OriginReply, { type: "capture-records" }>) => void;
  cache: (part: Extract<OriginReply, { type: "capture-cache" }>) => void;
}

const CAPTURE_ENDING: Ending = {
  what: "capture",
  late: () => new WorkspaceError("CaptureTimedOut", "The page stopped sending its data."),
  gone: () =>
    new WorkspaceError("AgentDisconnected", "The page closed before its data was captured."),
};

/**
 * Probes a validated agent and asks it for its page's data; each message restarts `idleMs`. A
 * session scope asks for its tab's sessionStorage alone.
 */
export async function captureThroughAgent(
  port: OriginPort,
  operation: BarrierOperation,
  receiver: CaptureReceiver,
  { idleMs, scope = "origin" }: { idleMs: number; scope?: StorageScope },
): Promise<CapturedPage> {
  await probeLink(port, operation, idleMs, CAPTURE_ENDING);
  return exchange<CapturedPage>(port, operation, {
    command: { type: "capture", scope },
    boundMs: idleMs,
    idle: true,
    onReply: (reply, settle) => {
      if (reply.type === "capture-storage") receiver.storage(reply);
      else if (reply.type === "capture-database") receiver.database(reply.database);
      else if (reply.type === "capture-records") receiver.records(reply);
      else if (reply.type === "capture-cache") receiver.cache(reply);
      else if (reply.type === "captured") {
        settle.resolve({ counts: reply.counts, cookieNames: reply.cookieNames });
      } else failedWith(reply, settle, "capture");
    },
    late: CAPTURE_ENDING.late,
    gone: CAPTURE_ENDING.gone,
  });
}
