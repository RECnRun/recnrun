import { isDeepStrictEqual } from "node:util";

/** What the tolerant reader answered for the probe's path. */
export interface TolerantRead {
  publication?: Record<string, unknown>;
  reason: string;
}

/** One stalled overwrite of the probe, stopped by a cancel or a dropped connection. */
export interface Interruption {
  /** `.crdownload` names seen in the probe's folder while the download ran. */
  during: string[];
  readDuring?: TolerantRead;
  /** The item left `in_progress` within the wait after the stop, with no cleanup cancel. */
  settledInWait: boolean;
  /** The item as it settled, before any cleanup by the harness. */
  settled?: { state: string; error?: string; filename: string };
  /** The probe's folder once the item settled, before any cleanup. */
  entries: string[];
  /** Entries of the download folder outside `RECnRun/`, such as a restart under the URL's name. */
  strays: string[];
  /** probe.json still holds the previous publication byte for byte. */
  bytesKept: boolean;
  readAfter?: TolerantRead;
}

/** How a hypothesis expects the item to settle. */
export interface Expected {
  name: string;
  error: (error: string | undefined) => boolean;
}

export const USER_CANCELED: Expected = {
  name: "USER_CANCELED",
  error: (error) => error === "USER_CANCELED",
};

export const NETWORK: Expected = {
  name: "NETWORK_*",
  error: (error) => error?.startsWith("NETWORK_") === true,
};

function settleProblems(run: Interruption, expected: Expected): string[] {
  const problems: string[] = [];
  if (run.during.length === 0) problems.push("no .crdownload was seen while the download ran");
  if (!run.settledInWait) {
    problems.push("the download still ran after the wait; the harness cancelled it");
  }
  const { state, error } = run.settled ?? { state: "unknown" };
  if (state !== "interrupted") problems.push(`the item settled as ${state}, not interrupted`);
  else if (!expected.error(error)) {
    problems.push(`the item settled with ${error ?? "no error"}, not ${expected.name}`);
  }
  return problems;
}

function retainedProblems(run: Interruption, previous: Record<string, unknown>): string[] {
  const exact = (read: TolerantRead | undefined) =>
    read?.reason === "fresh" && isDeepStrictEqual(read.publication, previous);
  const problems: string[] = [];
  if (!exact(run.readDuring)) {
    problems.push("the reader did not answer the exact previous publication while it ran");
  }
  if (!exact(run.readAfter)) {
    problems.push("the reader did not answer the exact previous publication after the stop");
  }
  if (!run.bytesKept) problems.push("probe.json no longer holds the previous publication");
  return problems;
}

/** Why an interruption does not hold: the partial, the state, the exact publication, the cleanup. */
export function interruptionProblems(
  run: Interruption,
  previous: Record<string, unknown>,
  expected: Expected,
): string[] {
  const left = [...run.entries.filter((entry) => entry !== "probe.json"), ...run.strays];
  const cleanup = left.length > 0 ? [`left after the stop: ${left.join(", ")}`] : [];
  return [...settleProblems(run, expected), ...retainedProblems(run, previous), ...cleanup];
}
