import type { LoadedExtension } from "../browser/fixtures/extension.ts";
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

/** The browser E1 ran on and how the isolator got into it. */
export interface E1Browser {
  chrome: string;
  method: string;
  label?: "diagnostic";
}

const VERDICT_OF: Record<Status, Verdict["verdict"]> = {
  allowed: "pass",
  rejected: "fail",
  unavailable: "unavailable",
};

export function browserOf(extension: Pick<LoadedExtension, "chrome" | "method" | "label">) {
  const { chrome, method, label } = extension;
  const browser: E1Browser = { chrome: chrome.version, method };
  if (label) browser.label = label;
  return browser;
}

/** The load method and, on a diagnostic browser, its label (PLAN.md decisions 3 and 7). */
export function provenance({ method, label }: E1Browser): Pick<E1Browser, "method" | "label"> {
  return label ? { method, label } : { method };
}

/** The verdict and the `capabilities.json` entry of one probe across its samples. */
export function aggregate(id: string, results: ProbeResult[], browser: E1Browser) {
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
    chrome: browser.chrome,
    samples: ran,
    ...provenance(browser),
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
    ...provenance(browser),
    details: results.map((result) => result.detail ?? null),
  };
  return { verdict, capability };
}

/** Every probe's verdict and its `capabilities.json` entry under `debugger`. */
export function summarize(
  samples: ReadonlyMap<string, ProbeResult[]>,
  descriptions: Record<string, string>,
  browser: E1Browser,
): { verdicts: Verdict[]; capabilities: Record<string, unknown> } {
  const verdicts: Verdict[] = [];
  const capabilities: Record<string, unknown> = {};
  for (const [id, results] of samples) {
    const { verdict, capability } = aggregate(id, results, browser);
    verdicts.push(verdict);
    capabilities[id] = { description: descriptions[id] ?? "", ...capability };
  }
  return { verdicts, capabilities };
}
