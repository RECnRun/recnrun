import { sized } from "../experiments/samples.ts";
import { expectEveryHypothesis } from "../experiments/outcome.ts";
import { EXPERIMENT, HYPOTHESES, recorderOf } from "../headless/fixtures/e13-cells.ts";
import { alternateCell, workerCells } from "../headless/fixtures/e13-flow.ts";
import { v1Lab } from "../headless/fixtures/e13-lab.ts";
import { hostRig, hostWhere } from "./fixtures/e13-host.ts";
import { test } from "./fixtures/host-chrome.ts";
import { evidence, requireHost } from "./fixtures/host-env.ts";

/*
 * E13's host twin (POC PLAN.md P7.4): the lab's worker cells on the installed Google Chrome of this
 * Mac, over throwaway roots below RECNRUN_HOST_ROOTS, with a throwaway headed root as master and never
 * the personal Default. The clone cells and the bootstrap-tab diagnostic need the lab's attached
 * master or a debugging port on a worker, so they are recorded unavailable here with that reason;
 * the owner's base is covered by the P5.5 host twin.
 */

const WORKERS = sized(4, 2);
const CLONES_REASON =
  "not run on the host: the clone cells need a master this run can attach to, and the owner's personal Default is never launched or read; the lab verdicts and the P5.5 host twin cover clones";
const CLONE_CELLS = ["t9.clones", "ops.tabs", "ops.marker", "t9.commands", "t9.exclusive"];
const DIAGNOSTIC =
  "not run on the host: the diagnostic attaches Playwright to a headless worker through a debugging port, which the owner's host runs never open on a worker";

test.describe.configure({ mode: "serial", timeout: 1_800_000 });

test.beforeAll(() => {
  requireHost();
});

test("headless workers on separate roots: link, commands, navigation, background", async () => {
  const lab = await v1Lab(WORKERS, hostRig);
  try {
    await workerCells(lab, recorderOf(hostWhere()));
  } finally {
    await lab.dispose();
  }
});

test("one worker root opened headed, headless, headed keeps its identity, cookie, and link", async () => {
  const lab = await v1Lab(1, hostRig);
  try {
    await alternateCell(lab, recorderOf(hostWhere()));
  } finally {
    await lab.dispose();
  }
});

test("the cells that need the lab's master are recorded with the reason they did not run", async () => {
  const { unavailable } = recorderOf(hostWhere());
  const topology = "clones of the frozen base opened by clone-open.sh headless";
  for (const hypothesis of CLONE_CELLS) await unavailable(hypothesis, topology, CLONES_REASON);
  await unavailable(
    "diag.bootstrapTab",
    "a hand-installed worker with a debugging port",
    DIAGNOSTIC,
  );
});

test("every E13 hypothesis left a verdict", async () => {
  await expectEveryHypothesis(EXPERIMENT, HYPOTHESES, evidence().directory);
});
