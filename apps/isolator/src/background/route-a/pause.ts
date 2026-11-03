import { messageOf } from "@/background/probes/helpers";
import type { Debuggee, DebuggerApi } from "@/background/probes/types";
import { bootstrap, command, release } from "@/background/route-a/attached";
import type { JournalEntry, PauseRecord } from "@/background/route-a/types";

// E2: Cache Storage did not exist yet at the waitForDebugger pause; this says whether it does here.
const TYPEOF_EXPRESSION = "({ caches: typeof caches, CacheStorage: typeof CacheStorage })";

/** Sends `method` on the session and records `ok` or Chrome's exact error as one step. */
async function step(
  pause: PauseRecord,
  api: DebuggerApi,
  session: Debuggee,
  [label, method, params]: [string, string, { [key: string]: unknown }?],
): Promise<Record<string, unknown> | undefined> {
  const record = { step: label, result: "pending" };
  pause.steps.push(record);
  try {
    const reply = await command(api, session, method, params);
    record.result = "ok";
    return reply;
  } catch (error) {
    record.result = messageOf(error);
    return undefined;
  }
}

function sessionOf(source: Debuggee, entry: JournalEntry): Debuggee {
  return { tabId: source.tabId, sessionId: entry.sessionId };
}

/**
 * Enables the debugger and an instrumentation breakpoint before script execution, then releases the
 * worker; a paused service worker answers only once released, so nothing is awaited before that.
 */
export async function prepareAndRelease(
  api: DebuggerApi,
  source: Debuggee,
  entry: JournalEntry,
): Promise<void> {
  const session = sessionOf(source, entry);
  const pause: PauseRecord = { steps: [], paused: false, laterPauses: 0 };
  entry.pause = pause;
  const enabled = step(pause, api, session, ["Debugger.enable", "Debugger.enable"]);
  const instrumentation = { instrumentation: "beforeScriptExecution" };
  const name = "Debugger.setInstrumentationBreakpoint";
  const breakpoint = step(pause, api, session, [name, name, instrumentation]).then((reply) => {
    if (typeof reply?.breakpointId === "string") pause.breakpointId = reply.breakpointId;
  });
  await release(api, session, entry);
  await Promise.all([enabled, breakpoint]);
}

function describePause(params: unknown): { reason: string; text: string } {
  const { reason, data } = (params ?? {}) as { reason?: unknown; data?: { url?: unknown } };
  const url = typeof data?.url === "string" ? ` ${data.url}` : "";
  return { reason: String(reason), text: `${String(reason)}${url}` };
}

/**
 * At the first instrumentation pause: reads whether Cache Storage exists, evaluates the bootstrap,
 * removes the breakpoint, and resumes. Any later pause is resumed at once.
 */
export async function handlePaused(
  api: DebuggerApi,
  source: Debuggee,
  entry: JournalEntry,
  { params, now }: { params: unknown; now: () => number },
): Promise<void> {
  const pause = entry.pause;
  if (!pause) return;
  const session = sessionOf(source, entry);
  const { reason, text } = describePause(params);
  if (pause.paused || reason !== "instrumentation") {
    pause.laterPauses += 1;
    await step(pause, api, session, ["Debugger.resume", "Debugger.resume"]);
    return;
  }
  pause.paused = true;
  pause.pausedMs = now() - entry.attachedAt;
  pause.steps.push({ step: "Debugger.paused", result: text });
  const probe = { expression: TYPEOF_EXPRESSION, returnByValue: true };
  const seen = await step(pause, api, session, [
    "Runtime.evaluate typeof",
    "Runtime.evaluate",
    probe,
  ]);
  if (seen) pause.typeofAtPause = (seen.result as { value?: unknown } | undefined)?.value;
  await bootstrap(api, session, entry, now);
  if (pause.breakpointId !== undefined) {
    const remove = { breakpointId: pause.breakpointId };
    await step(pause, api, session, [
      "Debugger.removeBreakpoint",
      "Debugger.removeBreakpoint",
      remove,
    ]);
  }
  await step(pause, api, session, ["Debugger.resume", "Debugger.resume"]);
}
