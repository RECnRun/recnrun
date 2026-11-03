import * as v from "valibot";

const Environment = v.picklist(["lab", "host"]);
const Install = v.picklist(["loadUnpacked", "managed-policy", "load-unpacked-gesture", "none"]);
const Variant = v.picklist(["test", "poc-d0", "poc-d1", "poc-d2"]);
const DebuggerState = v.picklist(["none", "declared", "attached"]);
const Topology = v.pipe(v.string(), v.nonEmpty());

const VerdictFields = {
  experiment: v.pipe(v.string(), v.nonEmpty()),
  hypothesis: v.pipe(v.string(), v.nonEmpty()),
  /** `--version` of the browser that ran it, as versions.json records it. */
  chrome: v.pipe(v.string(), v.nonEmpty()),
  environment: Environment,
  install: Install,
  /** `diagnostic` when a CDP client was connected, `strict` when none could exist. */
  label: v.picklist(["diagnostic", "strict"]),
  externalClient: v.boolean(),
  variant: Variant,
  topology: Topology,
  debugger: DebuggerState,
  observations: v.optional(v.array(v.record(v.string(), v.unknown()))),
  /** `smoke` when `verify` ran with one sample per hypothesis; absent means full evidence. */
  mode: v.optional(v.picklist(["smoke", "full"])),
};

/** One hypothesis outcome (POC PLAN.md decision 8); `unavailable` may have no sample but names why. */
const Outcome = v.variant("verdict", [
  v.strictObject({
    ...VerdictFields,
    verdict: v.picklist(["pass", "fail"]),
    error: v.optional(v.string()),
    samples: v.pipe(v.number(), v.integer(), v.minValue(1)),
  }),
  v.strictObject({
    ...VerdictFields,
    verdict: v.literal("unavailable"),
    error: v.pipe(v.string(), v.nonEmpty()),
    samples: v.pipe(v.number(), v.integer(), v.minValue(0)),
  }),
]);

/** `strict` approves only a run no CDP client could reach (POC PLAN.md decision 2). */
export const Verdict = v.pipe(
  Outcome,
  v.check(
    ({ label, externalClient, install }) =>
      label !== "strict" || (!externalClient && install !== "loadUnpacked"),
    "A strict verdict needs externalClient false and an install other than loadUnpacked.",
  ),
);
export type Verdict = v.InferOutput<typeof Verdict>;

export const Gestures = v.strictObject({
  cell: v.string(),
  gestures: v.pipe(v.number(), v.integer(), v.minValue(0)),
  steps: v.array(v.string()),
});
export type Gestures = v.InferOutput<typeof Gestures>;

/** One experiment cell: where, how installed, and what the operation touches. */
export const Cell = v.strictObject({
  environment: Environment,
  install: Install,
  variant: Variant,
  topology: Topology,
  debugger: DebuggerState,
  roots: v.array(v.string()),
  downloadsLayout: v.string(),
  operation: v.string(),
  clone: v.boolean(),
  templateState: v.picklist(["none", "frozen", "live"]),
});
export type Cell = v.InferOutput<typeof Cell>;

const VerdictsFile = v.array(Verdict);

/** The shape of `versions.json`, written by the test image. */
export const VersionsFile = v.strictObject({
  chrome: v.pipe(v.string(), v.nonEmpty()),
  node: v.string(),
  pnpm: v.string(),
  playwright: v.string(),
  image: v.string(),
});
export type VersionsFile = v.InferOutput<typeof VersionsFile>;

/** Parses verdicts or throws naming the first offending path. */
export function parseVerdicts(data: unknown): Verdict[] {
  const result = v.safeParse(VerdictsFile, data);
  if (result.success) return result.output;
  const issue = result.issues[0];
  throw new Error(`Invalid verdicts at ${v.getDotPath(issue) ?? "(root)"}: ${issue.message}`);
}
