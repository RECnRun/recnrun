import { fileUrlReads, overwriteMany, writeCompletes } from "./downloads-cells.ts";
import type { DownloadsEnvironment } from "./downloads-cells.ts";
import {
  absoluteRefused,
  contentRoundTrips,
  customLocation,
  defaultLocation,
} from "./downloads-cells-paths.ts";
import { interruptedTolerated, saveAsPrompts, visibleTraces } from "./downloads-cells-states.ts";
import type { Sample } from "./downloads-verdicts.ts";
import type { Verdict } from "../verdicts.ts";

/** E2's hypotheses (POC PLAN.md P1.3), shared by the lab spec and its host twin. */
export const E2_CELLS: Record<string, (environment: DownloadsEnvironment) => Promise<Sample>> = {
  "E2.write.completes": writeCompletes,
  "E2.filename.fileUrl": fileUrlReads,
  "E2.overwrite.100": overwriteMany,
  "E2.content.roundTrip": contentRoundTrips,
  "E2.interrupted.crdownload": interruptedTolerated,
  "E2.saveAs.prompt": saveAsPrompts,
  "E2.location.custom": customLocation,
  "E2.location.default": defaultLocation,
  "E2.traces": visibleTraces,
  "E2.path.absoluteRefused": absoluteRefused,
};

/** Why the E2 verdicts are incomplete: a hypothesis with no verdict, or one with no sample and no reason. */
export function missingVerdicts(verdicts: readonly Verdict[]): string[] {
  const latest = new Map(
    verdicts.filter((entry) => entry.experiment === "E2").map((entry) => [entry.hypothesis, entry]),
  );
  return Object.keys(E2_CELLS).flatMap((hypothesis) => {
    const verdict = latest.get(hypothesis);
    if (!verdict) return [`${hypothesis} left no verdict`];
    const sampled = verdict.samples > 0 || (verdict.verdict === "unavailable" && verdict.error);
    return sampled ? [] : [`${hypothesis} took no sample`];
  });
}
