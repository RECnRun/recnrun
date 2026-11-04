import { fileUrlReads, overwriteMany, writeCompletes } from "./downloads-cells.ts";
import type { DownloadsEnvironment } from "./downloads-cells.ts";
import {
  absoluteRefused,
  contentRoundTrips,
  customLocation,
  defaultLocation,
} from "./downloads-cells-paths.ts";
import {
  interruptedByCancel,
  interruptedByNetwork,
  saveAsPrompts,
} from "./downloads-cells-states.ts";
import { historyTraces, uiTraces } from "./downloads-cells-traces.ts";
import type { Sample, VerdictTarget } from "./downloads-verdicts.ts";
import { expectEveryHypothesis } from "../outcome.ts";

/** E2's hypotheses (POC PLAN.md P1.3), shared by the lab spec and its host twin. */
export const E2_CELLS: Record<string, (environment: DownloadsEnvironment) => Promise<Sample>> = {
  "E2.write.completes": writeCompletes,
  "E2.filename.fileUrl": fileUrlReads,
  "E2.overwrite.100": overwriteMany,
  "E2.content.roundTrip": contentRoundTrips,
  "E2.interrupted.cancel": interruptedByCancel,
  "E2.interrupted.network": interruptedByNetwork,
  "E2.saveAs.prompt": saveAsPrompts,
  "E2.location.custom": customLocation,
  "E2.location.default": defaultLocation,
  "E2.traces.history": historyTraces,
  "E2.traces.ui": uiTraces,
  "E2.path.absoluteRefused": absoluteRefused,
};

/** Fails when an E2 hypothesis left no verdict in `target`'s folder, or one with no sample and no reason. */
export const expectEveryE2 = (target: VerdictTarget): Promise<void> =>
  expectEveryHypothesis("E2", Object.keys(E2_CELLS), target.directory?.());
