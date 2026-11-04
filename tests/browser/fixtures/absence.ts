import { CdpClosedError, CdpDetachedError } from "./cdp-client.ts";

// Playwright words for a worker, page, or context that went away under a read.
const GONE = /has been closed|Execution context was destroyed|Cannot find context|Target closed/;

/**
 * Whether `error` only says what a poll waits for is not there yet: a file not written, a file
 * half written, or a worker that stopped or was replaced. Anything else is the harness's error.
 */
function isAbsence(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  if (error instanceof CdpDetachedError || error instanceof CdpClosedError) return true;
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR" || GONE.test(error.message);
}

/** Runs `read`; absence is `undefined`, any other failure propagates. */
export async function readOrAbsent<T>(read: () => Promise<T | undefined>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (isAbsence(error)) return undefined;
    throw error;
  }
}
