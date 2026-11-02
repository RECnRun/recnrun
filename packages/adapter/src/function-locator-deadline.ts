import type { LocatorDeadline } from "@recnrun/protocol";
import * as v from "valibot";
import type { CdpSession } from "./cdp-link.ts";

const TIMED_OUT = Symbol("timed out");

const TwoSchema = v.object({ result: v.object({ value: v.literal(2) }) });

/** Settles with the promise, or with `TIMED_OUT` after `ms`; the promise keeps running. */
export function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export const timedOut = (value: unknown): value is typeof TIMED_OUT => value === TIMED_OUT;

/** Whether the renderer runs `1+1` within `ms`; a page stuck in synchronous code does not. */
async function answers(session: CdpSession, ms: number): Promise<boolean> {
  const reply = session
    .send("Runtime.evaluate", { expression: "1+1", returnByValue: true })
    .then((result) => v.is(TwoSchema, result))
    .catch(() => false);
  return (await within(reply, ms)) === true;
}

/**
 * Handles a locator call that outlived its timeout. A Promise timeout alone cannot stop JavaScript,
 * so when the renderer is blocked it sends `Runtime.terminateExecution` on the same session and
 * probes again; a renderer that answers was only awaiting, and nothing is terminated.
 */
export async function cutAtDeadline(
  session: CdpSession,
  timeoutMs: number,
  probeMs: number,
): Promise<LocatorDeadline> {
  if (await answers(session, probeMs))
    return { timeoutMs, blocked: false, terminated: false, tabResponsive: true };
  const sent = session.send("Runtime.terminateExecution").then(
    () => true,
    () => false,
  );
  const terminated = (await within(sent, probeMs)) === true;
  const tabResponsive = await answers(session, probeMs);
  return { timeoutMs, blocked: true, terminated, tabResponsive };
}
