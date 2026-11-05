import { test } from "./fixtures/host-chrome.ts";
import { evidence, requireHost } from "./fixtures/host-env.ts";
import { hostEnvironment } from "./fixtures/e4-host.ts";
import { expectEveryHypothesis, recordUnavailable } from "../experiments/outcome.ts";
import type { Cell } from "../experiments/outcome.ts";
import { EXPERIMENT, HYPOTHESES } from "../headless/fixtures/e13-cells.ts";

/*
 * E13's host twin (POC PLAN.md P7.4): the same hypotheses on the installed Google Chrome of this Mac,
 * over throwaway roots below RECNRUN_HOST_ROOTS and RECNRUN_HOST_BASES, with a throwaway headed root
 * as master, never the personal Default. The host rig for it is not built yet: every cell is
 * recorded unavailable with that reason until the orchestrator and the owner run it, so the host
 * twin never reports a result it did not measure.
 */

const REASON =
  "pending: the host rig of E13 (a throwaway headed master and install.sh-installed worker roots opened by open.sh headless) is not built; the lab verdicts of E13 stand for the mechanism and the owner's host run is still to do";

const cellOf = async (hypothesis: string): Promise<Cell> => ({
  experiment: EXPERIMENT,
  hypothesis,
  chrome: await hostEnvironment.target.chrome(),
  environment: "host",
  install: "loadUnpacked",
  label: "diagnostic",
  externalClient: true,
  variant: "poc-d0",
  topology:
    "a throwaway headed root as master and throwaway worker roots, no CDP client on any worker",
  debugger: "none",
});

test.describe("E13 on the host: headless workers on separate roots", () => {
  test.beforeAll(() => {
    requireHost();
  });

  test("every hypothesis is recorded with the reason it did not run", async () => {
    for (const hypothesis of HYPOTHESES) {
      await recordUnavailable(await cellOf(hypothesis), REASON, evidence().directory);
    }
  });

  test("every E13 hypothesis left a verdict", async () => {
    await expectEveryHypothesis(EXPERIMENT, HYPOTHESES, evidence().directory);
  });
});
