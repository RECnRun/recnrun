import { UnavailableError } from "../../browser/fixtures/policy-install.ts";
import { sized } from "../samples.ts";
import type { Verdict } from "../verdicts.ts";

/** One sample of a hypothesis: whether it held, why not, and what was seen. */
export interface Sample {
  ok: boolean;
  error?: string;
  observation: Record<string, unknown>;
}

/** Where E2 ran and where its verdicts go (the lab's evidence folder, or the host's). */
export interface VerdictTarget {
  environment: "lab" | "host";
  chrome(): Promise<string>;
  append(verdict: Verdict): Promise<void>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `unavailable` only when the cell could not run at all; it names the reason with no sample. */
function outcome(samples: Sample[], unavailable: string | undefined) {
  if (unavailable && samples.length === 0) {
    return { verdict: "unavailable" as const, error: unavailable, samples: 0 };
  }
  const errors = samples.flatMap((sample) => (sample.error ? [sample.error] : []));
  const passed = samples.length > 0 && samples.every((sample) => sample.ok);
  const error = unavailable ?? (errors.length > 0 ? errors.join(" | ") : undefined);
  const verdict = passed ? ("pass" as const) : ("fail" as const);
  return { verdict, ...(error === undefined ? {} : { error }), samples: samples.length };
}

async function takeSamples(take: () => Promise<Sample>, count: number) {
  const samples: Sample[] = [];
  for (let index = count; index > 0; index--) {
    try {
      samples.push(await take());
    } catch (error) {
      if (error instanceof UnavailableError) return { samples, unavailable: error.message };
      samples.push({ ok: false, error: message(error), observation: {} });
    }
  }
  return { samples, unavailable: undefined };
}

/** Runs `take` `sized(3)` times and records one E2 verdict: D0, one root, installed over CDP. */
export async function recordE2(
  hypothesis: string,
  target: VerdictTarget,
  take: () => Promise<Sample>,
): Promise<Verdict> {
  const { samples, unavailable } = await takeSamples(take, sized(3));
  const verdict = {
    experiment: "E2",
    hypothesis,
    ...outcome(samples, unavailable),
    chrome: await target.chrome(),
    environment: target.environment,
    install: "loadUnpacked",
    label: "diagnostic",
    externalClient: true,
    variant: "poc-d0",
    topology: "single",
    debugger: "none",
    observations: samples.map((sample) => sample.observation),
  } satisfies Verdict;
  await target.append(verdict);
  console.log(JSON.stringify(verdict));
  return verdict;
}

/** A sample from a list of problems: it held when there were none. */
export function judged(problems: string[], observation: Record<string, unknown>): Sample {
  if (problems.length === 0) return { ok: true, observation };
  return { ok: false, error: problems.join("; "), observation };
}
