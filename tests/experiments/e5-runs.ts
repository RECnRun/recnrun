import type { Sample } from "./fixtures/downloads-verdicts.ts";
import type { E5Environment } from "./fixtures/e5-run.ts";
import {
  disconnectForgetSample,
  fifthSample,
  killExecutorSample,
  meshSample,
} from "./e5-mesh-samples.ts";
import {
  bothRestartSample,
  closePagesSample,
  noPageSample,
  quitAfterAnswerSample,
  quitDuringIceSample,
} from "./e5-restart-samples.ts";
import { arrivalSample, iceCompleteSample, simultaneousSample } from "./e5-samples.ts";
import type { E5Hypothesis } from "./e5-samples.ts";
import {
  clockChangeSample,
  corruptSample,
  duplicateSample,
  expiredSample,
  previousRunSample,
  readCacheSample,
} from "./e5-virtual-samples.ts";

/** One E5 cell as a spec runs it: its title, its sample, and how many samples a full run takes. */
interface E5Run {
  title: string;
  sample: (environment: E5Environment) => Promise<Sample>;
  full?: number;
}

/** Every E5 cell, in the order the lab spec and its host twin run them. */
export const E5_RUNS: Record<E5Hypothesis, E5Run> = {
  "E5.a.arrival": {
    title: "the offer and the answer are read within one poll",
    sample: arrivalSample,
  },
  "E5.a.iceComplete": {
    title: "each side publishes once, its candidates gathered",
    sample: iceCompleteSample,
  },
  "E5.a.previousRun": {
    title: "an earlier boot and a lower sequence are not answered",
    sample: previousRunSample,
  },
  "E5.a.simultaneous": {
    title: "two profiles arriving together link from one offer",
    sample: simultaneousSample,
  },
  "E5.a.duplicate": {
    title: "a repeated offer or answer changes nothing",
    sample: duplicateSample,
  },
  "E5.a.expired": {
    title: "an expired offer or presence is not answered",
    sample: expiredSample,
  },
  "E5.a.corrupt": {
    title: "a truncated, malformed, or contradicting file is not answered",
    sample: corruptSample,
  },
  "E5.a.clockChange": {
    title: "files stamped an hour off are refused by the documented bounds",
    sample: clockChangeSample,
  },
  "E5.a.quitDuringIce": {
    title: "the answerer crashes while it gathers, returns, and links",
    sample: quitDuringIceSample,
  },
  "E5.a.quitAfterAnswer": {
    title: "the answerer crashes once its answer is out, returns, and links",
    sample: quitAfterAnswerSample,
  },
  "E5.a.bothRestart": {
    title: "both restart and link with the same identities",
    sample: bothRestartSample,
  },
  "E5.a.readCache": {
    title: "every rewrite of one offer path is read afresh",
    sample: readCacheSample,
  },
  "E5.a.noPage": {
    title: "the pair links again with no extension page and no client",
    sample: noPageSample,
  },
  "E5.a.closePages": {
    title: "two presence lifetimes with every extension page closed",
    sample: closePagesSample,
    // Each sample waits two presence lifetimes, so two samples keep the cell under its timeout.
    full: 2,
  },
  "E5.b.mesh": { title: "five profiles form ten links over Downloads", sample: meshSample },
  "E5.b.fifth": {
    title: "a fifth profile joins four with no extension page open",
    sample: fifthSample,
  },
  "E5.b.killExecutor": {
    title: "a crashed worker is seen gone and links again",
    sample: killExecutorSample,
  },
  "E5.b.disconnectForget": {
    title: "Disconnect and Forget hold, and end linked again",
    sample: disconnectForgetSample,
  },
};
