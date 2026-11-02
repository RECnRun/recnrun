import type { Verdict } from "./verdicts.ts";

// Pure part of E1 (tests/experiments/E1-debugger-capabilities.spec.ts), so Node unit tests reach it.
const EXPERIMENT = "E1";

export type Status = "allowed" | "rejected" | "unavailable";

/** One probe outcome as the isolator returns it (apps/isolator/src/background/probes/types.ts). */
export interface ProbeResult {
  id: string;
  status: Status;
  error?: string;
  detail?: unknown;
}

const VERDICT_OF: Record<Status, Verdict["verdict"]> = {
  allowed: "pass",
  rejected: "fail",
  unavailable: "unavailable",
};

/** The verdict and the `capabilities.json` entry of one probe across its samples. */
export function aggregate(id: string, results: ProbeResult[], chrome: string) {
  const statuses = results.map((result) => result.status);
  const ran = statuses.filter((status) => status !== "unavailable").length;
  const uniform = statuses.every((status) => status === statuses[0]);
  const status: Status = uniform ? (statuses[0] ?? "unavailable") : "rejected";
  const errors = [...new Set(results.flatMap((result) => (result.error ? [result.error] : [])))];
  const error = uniform
    ? errors[0]
    : `inconsistent across samples (${statuses.join(", ")}): ${errors.join(" | ")}`;
  const verdict: Verdict = {
    experiment: EXPERIMENT,
    hypothesis: id,
    verdict: VERDICT_OF[status],
    ...(error && status !== "allowed" ? { error } : {}),
    chrome,
    samples: ran,
    variants: results.map((result, index) => ({
      name: `sample ${index + 1}`,
      verdict: VERDICT_OF[result.status],
      ...(result.error ? { error: result.error } : {}),
    })),
  };
  const capability = {
    status,
    statuses,
    ...(error ? { error } : {}),
    details: results.map((result) => result.detail ?? null),
  };
  return { verdict, capability };
}
