import { provenance } from "./e1-aggregate.ts";
import type { E1Browser } from "./e1-aggregate.ts";
import { KINDS, NOTES, evaluateSample } from "./e7-samples.ts";
import type { E7Sample, SampleOutcome } from "./e7-samples.ts";
import type { Verdict } from "./verdicts.ts";

// E7's verdicts from its samples (e7-samples.ts), pure so Node unit tests reach them.
const EXPERIMENT = "E7";

/** Every distinct reason with how often it happened, or `undefined` when every sample passed. */
function failureOf(outcomes: SampleOutcome[]): string | undefined {
  if (outcomes.length === 0) return "no sample ran";
  const failed = outcomes.filter((outcome) => !outcome.passed).length;
  if (failed === 0) return undefined;
  const listed = tally(outcomes.flatMap((outcome) => outcome.reasons)).join("; ");
  return `${failed} of ${outcomes.length} samples failed: ${listed}`;
}

function tally(texts: string[]): string[] {
  const counted = new Map<string, number>();
  for (const text of texts) counted.set(text, (counted.get(text) ?? 0) + 1);
  return [...counted].map(([text, count]) => `${text} (${count})`);
}

function countsOf(outcomes: SampleOutcome[]): Record<string, number> {
  const count = (has: (outcome: SampleOutcome) => boolean) => outcomes.filter(has).length;
  const counts: Record<string, number> = {
    samples: outcomes.length,
    passed: count((outcome) => outcome.passed),
  };
  for (const kind of KINDS) counts[kind] = count((outcome) => outcome.kinds.includes(kind));
  for (const note of NOTES) counts[note] = count((outcome) => outcome.notes.includes(note));
  return counts;
}

function variantsOf<T extends { variant: string }>(
  samples: T[],
  failure: (own: T[]) => string | undefined,
): NonNullable<Verdict["variants"]> {
  const names = [...new Set(samples.map((sample) => sample.variant))];
  return names.map((name) => {
    const own = samples.filter((sample) => sample.variant === name);
    const error = failure(own);
    const verdict: Verdict["verdict"] = error === undefined ? "pass" : "fail";
    return { name, verdict, ...(error === undefined ? {} : { error }), samples: own.length };
  });
}

function verdictOf(hypothesis: string, error: string | undefined, browser: E1Browser) {
  const verdict: Verdict["verdict"] = error === undefined ? "pass" : "fail";
  return {
    experiment: EXPERIMENT,
    hypothesis,
    verdict,
    ...(error === undefined ? {} : { error }),
    chrome: browser.chrome,
    ...provenance(browser),
  };
}

/** The realm passes only when every sample passed; otherwise the counts say how it failed. */
export function summarize(hypothesis: string, samples: E7Sample[], browser: E1Browser): Verdict {
  const failure = (own: E7Sample[]) => failureOf(own.map((sample) => evaluateSample(sample)));
  const outcomes = samples.map((sample) => evaluateSample(sample));
  return {
    ...verdictOf(hypothesis, failureOf(outcomes), browser),
    samples: samples.length,
    counts: countsOf(outcomes),
    variants: variantsOf(samples, failure),
  };
}

/** Two tabs of one session that construct the same shared worker, and the instances Chrome ran. */
export interface IdentitySample {
  variant: string;
  marker: string;
  instances: number;
  urls: string[];
}

function identityFailure(pairs: IdentitySample[]): string | undefined {
  if (pairs.length === 0) return "no pair ran";
  const separate = pairs.filter((pair) => pair.instances > 1).map((pair) => pair.variant);
  const none = pairs.filter((pair) => pair.instances === 0).map((pair) => pair.variant);
  const parts = [
    ...(separate.length > 0
      ? [
          `${separate.length} of ${pairs.length} pairs ran separate instances: ${tally(separate).join(", ")}`,
        ]
      : []),
    ...(none.length > 0
      ? [`${none.length} of ${pairs.length} pairs ran no instance: ${tally(none).join(", ")}`]
      : []),
  ];
  return parts.length > 0 ? parts.join("; ") : undefined;
}

/** A shared worker keeps its identity when two same-session tabs share one instance. */
export function summarizeIdentity(pairs: IdentitySample[], browser: E1Browser): Verdict {
  const count = (has: (pair: IdentitySample) => boolean) => pairs.filter(has).length;
  return {
    ...verdictOf("shared-worker-identity", identityFailure(pairs), browser),
    samples: pairs.length,
    counts: {
      samples: pairs.length,
      singleInstance: count((pair) => pair.instances === 1),
      separateInstances: count((pair) => pair.instances > 1),
      noInstance: count((pair) => pair.instances === 0),
    },
    variants: variantsOf(pairs, identityFailure),
  };
}

/** A realm the fixture or the browser gives no way to test. */
export function unavailable(hypothesis: string, error: string, browser: E1Browser): Verdict {
  return {
    experiment: EXPERIMENT,
    hypothesis,
    verdict: "unavailable",
    error,
    chrome: browser.chrome,
    samples: 0,
    ...provenance(browser),
  };
}

const WRAPPED = ["dedicated-worker", "shared-worker"];

/** What E7 adds to `capabilities.json`: the registration, how often it ran first, and every verdict. */
export function capabilitiesOf(verdicts: Verdict[], registration: unknown) {
  const page = verdicts.find((verdict) => verdict.hypothesis === "page")?.counts;
  const variants = (hypothesis: string) =>
    (verdicts.find((verdict) => verdict.hypothesis === hypothesis)?.variants ?? []).map(
      (variant) => [variant.name, variant.verdict] as const,
    );
  return {
    routeC: {
      registration,
      firstScript: { before: page?.beforeFirstScript ?? 0, samples: page?.samples ?? 0 },
      realms: Object.fromEntries(verdicts.map((verdict) => [verdict.hypothesis, verdict.verdict])),
      wrappers: Object.fromEntries(
        WRAPPED.map((hypothesis) => [hypothesis, Object.fromEntries(variants(hypothesis))]),
      ),
    },
  };
}
