/** How many samples an experiment takes: `full` for evidence, `smoke` inside `verify`. */
export type SampleMode = "full" | "smoke";

/** `RECNRUN_EXPERIMENT_SAMPLES=smoke` keeps one sample per hypothesis; scripts/test-container.mjs sets it for `verify`. */
export function sampleMode(env: NodeJS.ProcessEnv = process.env): SampleMode {
  return env.RECNRUN_EXPERIMENT_SAMPLES === "smoke" ? "smoke" : "full";
}

/** `full` samples for evidence; `few` in a smoke run. */
export function sized(full: number, few = 1, env: NodeJS.ProcessEnv = process.env): number {
  return sampleMode(env) === "smoke" ? few : full;
}
