import { withMarker } from "@recnrun/worker-bootstrap";
import type { AttachedEvent } from "@/background/probes/auto-attach";
import { messageOf, withTimeout } from "@/background/probes/helpers";
import { REFUSED } from "@/background/probes/loopback";
import type { Debuggee, DebuggerApi } from "@/background/probes/types";
import type { JournalEntry } from "@/background/route-a/types";

/** Targets whose global the bootstrap patches; Chrome names them so in `Target.attachedToTarget`. */
const WORKER_TYPES = new Set(["service_worker", "worker", "shared_worker"]);

export const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

export async function command(
  api: DebuggerApi,
  target: Debuggee,
  method: string,
  params?: { [key: string]: unknown },
): Promise<Record<string, unknown>> {
  const result = await withTimeout(api.sendCommand(target, method, params), method);
  return (result ?? {}) as Record<string, unknown>;
}

function fail(entry: JournalEntry, error: unknown): void {
  entry.error ??= messageOf(error);
}

/** The exception's description, or the text Chrome gives when there is none. */
export function exceptionText(reply: Record<string, unknown>): string | undefined {
  const details = reply.exceptionDetails as
    | { text?: string; exception?: { description?: string } }
    | undefined;
  return details ? (details.exception?.description ?? details.text ?? "exception") : undefined;
}

/** Evaluates the bootstrap carrying `marker` in `target` and records what happened. */
export async function bootstrap(
  api: DebuggerApi,
  target: Debuggee,
  entry: JournalEntry,
  now: () => number,
): Promise<void> {
  const marker = entry.marker ?? "";
  try {
    const expression = withMarker(marker);
    const reply = await command(api, target, "Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    entry.bootstrapMs = now() - entry.attachedAt;
    const failure = exceptionText(reply);
    if (failure === undefined) entry.installed = (reply.result as { value?: unknown })?.value;
    else fail(entry, failure);
  } catch (error) {
    fail(entry, error);
  }
}

export function entryOf(
  source: Debuggee,
  event: AttachedEvent,
  attachedAt: number,
  marker: string,
): JournalEntry {
  const { sessionId, waitingForDebugger, targetInfo } = event;
  const { targetId, type, url } = targetInfo;
  return {
    sessionId,
    ...(source.sessionId === undefined ? {} : { parentSessionId: source.sessionId }),
    targetId,
    type,
    url,
    waitingForDebugger,
    attachedAt,
    ...(WORKER_TYPES.has(type) ? { marker } : {}),
    released: false,
  };
}

/**
 * Sends the bootstrap, auto-attaches the target's own children, then releases the worker if it
 * waits: the session runs the bootstrap before the release, and nested workers pause in turn.
 */
export async function handleAttached(
  api: DebuggerApi,
  source: Debuggee,
  entry: JournalEntry,
  now: () => number,
): Promise<void> {
  const session = { tabId: source.tabId, sessionId: entry.sessionId };
  // A paused service worker answers Runtime.evaluate only once released, so its reply is awaited last.
  const booted = entry.marker === undefined ? undefined : bootstrap(api, session, entry, now);
  await release(api, session, entry);
  await booted;
}

/** Auto-attaches the target's own children, then releases it if it waits. */
export async function release(
  api: DebuggerApi,
  session: Debuggee,
  entry: JournalEntry,
): Promise<void> {
  try {
    await command(api, session, "Target.setAutoAttach", AUTO_ATTACH);
    entry.autoAttach = "ok";
  } catch (error) {
    entry.autoAttach = messageOf(error);
  }
  await runIfWaiting(api, session, entry);
}

async function runIfWaiting(api: DebuggerApi, session: Debuggee, entry: JournalEntry) {
  if (!entry.waitingForDebugger) return;
  try {
    await command(api, session, "Runtime.runIfWaitingForDebugger");
    entry.released = true;
  } catch (error) {
    fail(entry, error);
  }
}

/** R11: a child outside the loopback gets no bootstrap and no auto-attach, only its release. */
export async function releaseRefused(
  api: DebuggerApi,
  source: Debuggee,
  entry: JournalEntry,
): Promise<void> {
  delete entry.marker;
  entry.error = REFUSED;
  await runIfWaiting(api, { tabId: source.tabId, sessionId: entry.sessionId }, entry);
}
