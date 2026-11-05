import { test } from "../browser/fixtures/chrome.ts";
import { expectEveryHypothesis, recordHypothesis } from "../experiments/outcome.ts";
import { sized } from "../experiments/samples.ts";
import { cloneLab, clonesSample, exclusiveSample, remoteOf } from "./fixtures/e13-clones.ts";
import { commandsSample, markerSample, tabsSample } from "./fixtures/e13-remote.ts";
import { EXPERIMENT, HYPOTHESES, cellOf, record, recorderOf } from "./fixtures/e13-cells.ts";
import { bootstrapTabSample } from "./fixtures/e13-diagnostic.ts";
import { alternateCell, workerCells } from "./fixtures/e13-flow.ts";
import { v1Lab } from "./fixtures/e13-lab.ts";

/*
 * E13 (POC PLAN.md P7.4, T6 to T9): the master on a root of its own, workers each on a root of their
 * own, opened headless by the launcher's scripts with no CDP client on any worker. The master is a
 * headed Playwright Chrome on Xvfb that stands in for the personal Default. A failed hypothesis is a
 * verdict; the last test fails only when one left none.
 */

const WORKERS = sized(4, 2);
const CLONES = sized(3, 2);

test.describe.configure({ mode: "serial" });

test("headless workers on separate roots: link, commands, tabs, navigation, marker, background", async () => {
  const lab = await v1Lab(WORKERS);
  try {
    await workerCells(lab, recorderOf());
  } finally {
    await lab.dispose();
  }
});

test("one worker root opened headed, headless, headed keeps its identity, cookie, and link", async () => {
  const lab = await v1Lab(1);
  try {
    await alternateCell(lab, recorderOf());
  } finally {
    await lab.dispose();
  }
});

test("clones of the frozen base open headless, link to the master, answer, and stay exclusive", async ({
  browserName,
}, testInfo) => {
  test.skip(browserName === "firefox", "Chrome only");
  // Three rounds of clones and three exclusivity samples take longer than the config's ten minutes.
  test.setTimeout(sized(1_500_000, 600_000));
  const lab = await cloneLab(testInfo);
  const topology = `${CLONES} clones of one frozen base opened by clone-open.sh headless`;
  try {
    await record("t9.clones", topology, () => clonesSample(lab, ["A", "B", "C"].slice(0, CLONES)));
    const remote = remoteOf(lab);
    const opened = `${topology}; the master opens the test page in each clone`;
    await record("ops.tabs", opened, () => tabsSample(remote, lab.clones));
    await record("ops.marker", opened, () => markerSample(remote, lab.clones));
    await record("t9.commands", opened, () => commandsSample(remote, lab.clones));
    await record("t9.exclusive", `${topology}; a running clone is asked for the other mode`, () =>
      exclusiveSample(lab),
    );
  } finally {
    await lab.dispose();
  }
});

test("diagnostic: a headless worker's only target is its bootstrap tab, which it does not share", async () => {
  const topology =
    "1 hand-installed worker opened with open.sh's arguments in --headless=new plus a debugging port; Playwright is attached to it";
  const cell = {
    ...(await cellOf("diag.bootstrapTab", "")),
    topology,
    debugger: "attached" as const,
  };
  await recordHypothesis(cell, bootstrapTabSample, { full: 1 });
});

test("every E13 hypothesis left a verdict", async () => {
  await expectEveryHypothesis(EXPERIMENT, HYPOTHESES);
});
