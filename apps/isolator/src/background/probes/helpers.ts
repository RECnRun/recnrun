import type { Debuggee, ProbeContext, ProbeOutcome, TargetInfo } from "@/background/probes/types";

/** The protocol version `chrome.debugger.attach` asks for. */
export const PROTOCOL_VERSION = "1.3";
/** A command Chrome never answers is a result too; the probe must not hang the run. */
const COMMAND_TIMEOUT_MS = 5_000;

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  ms = COMMAND_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: no reply within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export type CommandResult = Record<string, unknown>;

export async function send(
  context: ProbeContext,
  target: Debuggee,
  method: string,
  params?: { [key: string]: unknown },
): Promise<CommandResult> {
  const result = await withTimeout(context.api.sendCommand(target, method, params), method);
  return (result ?? {}) as CommandResult;
}

/** `allowed` with what `run` returned, or `rejected` with Chrome's exact error text. */
export async function attempt(run: () => Promise<unknown>): Promise<ProbeOutcome> {
  try {
    const detail = await run();
    return detail === undefined ? { status: "allowed" } : { status: "allowed", detail };
  } catch (error) {
    return { status: "rejected", error: messageOf(error) };
  }
}

export function unavailable(reason: string): ProbeOutcome {
  return { status: "unavailable", error: reason };
}

export function findTarget(targets: readonly TargetInfo[], url: string): TargetInfo | undefined {
  return targets.find((target) => target.url.startsWith(url));
}

/** Attaches by target id and remembers it, so the cleanup probe detaches what is left. */
export async function attachTarget(context: ProbeContext, targetId: string): Promise<Debuggee> {
  const debuggee = { targetId };
  await withTimeout(context.api.attach(debuggee, PROTOCOL_VERSION), "attach");
  context.state.attached.push(debuggee);
  return debuggee;
}

export async function detachTarget(context: ProbeContext, debuggee: Debuggee): Promise<void> {
  context.state.attached = context.state.attached.filter((entry) => entry !== debuggee);
  await withTimeout(context.api.detach(debuggee), "detach");
}

export function tabDebuggee(context: ProbeContext): Debuggee | undefined {
  const { tabId, tabAttached } = context.state;
  return tabAttached && tabId !== undefined ? { tabId } : undefined;
}
