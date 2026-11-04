import type { Sample } from "./fixtures/downloads-verdicts.ts";
import type { E5Environment } from "./fixtures/e5-run.ts";
import {
  forgedMasterSample,
  thirdMasterSample,
  workerRestartSample,
} from "./e6-intruder-samples.ts";
import { tripSample } from "./e6-round-trip.ts";
import type { E6Hypothesis } from "./e6-samples.ts";

/** One E6 cell as a spec runs it: its title and its sample. */
interface E6Run {
  title: string;
  sample: (environment: E5Environment) => Promise<Sample>;
}

/** Every E6 cell, in the order the lab spec and its host twin run them. */
export const E6_RUNS: Record<E6Hypothesis, E6Run> = {
  "E6.a.absent": {
    title: "the workers keep running, bound, linked, and recording while the Default is closed",
    sample: tripSample("E6.a.absent"),
  },
  "E6.a.forgedMaster": {
    title: "a presence and offers under the Default's id with another key are refused",
    sample: forgedMasterSample,
  },
  "E6.a.thirdMaster": {
    title: "a third profile that records itself as master commands nothing",
    sample: thirdMasterSample,
  },
  "E6.b.relink": {
    title: "the same Default links with both workers again under the records it had",
    sample: tripSample("E6.b.relink"),
  },
  "E6.b.status": {
    title: "the Default shows the session that ran on in Worker 1 as its own, live",
    sample: tripSample("E6.b.status"),
  },
  "E6.b.results": {
    title: "nothing runs twice, and the Default's next command reaches that session",
    sample: tripSample("E6.b.results"),
  },
  "E6.c.workerRestart": {
    title: "a worker restart leaves the master up, its other link held, and the worker bound",
    sample: workerRestartSample,
  },
};
