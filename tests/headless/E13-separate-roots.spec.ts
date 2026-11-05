import { test } from "../browser/fixtures/chrome.ts";
import {
  expectEveryHypothesis,
  recordHypothesis,
  recordUnavailable,
} from "../experiments/outcome.ts";
import { sized } from "../experiments/samples.ts";
import { cloneLab, clonesSample } from "./fixtures/e13-clones.ts";
import { exclusiveSample } from "./fixtures/e13-clones.ts";
import {
  EXPERIMENT,
  HYPOTHESES,
  cellOf,
  commandsSample,
  record,
  workersSample,
} from "./fixtures/e13-cells.ts";
import { bootstrapTabSample } from "./fixtures/e13-diagnostic.ts";
import { alternateSample, backgroundSample } from "./fixtures/e13-lifecycle.ts";
import { v1Lab } from "./fixtures/e13-lab.ts";

/*
 * E13 (POC PLAN.md P7.4, T6 to T9): the master on a root of its own, workers each on a root of their
 * own, opened headless by the launcher's scripts with no CDP client on any worker. The master is a
 * headed Playwright Chrome on Xvfb that stands in for the personal Default. A failed hypothesis is a
 * verdict; the last test fails only when one left none.
 */

const WORKERS = sized(4, 2);
const CLONES = sized(3, 2);
const V1 = `${WORKERS} hand-installed workers, one root each, opened by open.sh headless`;

test.describe.configure({ mode: "serial" });

test("headless workers on separate roots: link, commands, tabs, navigation, marker, background", async () => {
  const lab = await v1Lab(WORKERS);
  try {
    await record("t6.workers", V1, () => workersSample(lab), 1);
    await record(
      "t6.commands",
      `${V1}; V1 has no path to bind a worker to the master`,
      () => commandsSample(lab),
      1,
    );
    await record(
      "t7.background",
      `${V1}; the master has no page open`,
      () => backgroundSample(lab),
      1,
    );
    const reason =
      "not applicable: headless has no window to focus and no picture-in-picture surface";
    await recordUnavailable(
      await cellOf("ops.navigation", V1),
      "not observable: headless Chrome takes one target, the bootstrap page, and no peer command navigates or opens a tab",
    );
    await recordUnavailable(await cellOf("focus", V1), reason);
    await recordUnavailable(await cellOf("pip", V1), reason);
  } finally {
    await lab.dispose();
  }
});

test("one worker root opened headed, headless, headed keeps its identity, cookie, and link", async () => {
  const lab = await v1Lab(1);
  try {
    await record(
      "t8.alternate",
      "one hand-installed worker root opened headed, headless, headed",
      () => alternateSample(lab),
      1,
    );
  } finally {
    await lab.dispose();
  }
});

test("clones of the frozen base open headless, link to the master, answer, and stay exclusive", async ({
  browserName,
}, testInfo) => {
  test.skip(browserName === "firefox", "Chrome only");
  const lab = await cloneLab(testInfo);
  const topology = `${CLONES} clones of one frozen base opened by clone-open.sh headless`;
  try {
    await record(
      "t9.clones",
      topology,
      () => clonesSample(lab, ["A", "B", "C"].slice(0, CLONES)),
      1,
    );
    const noTab =
      "not observable: a headless clone's only tab is its bootstrap page, the extension's own page, which the product never shares (tabs/open-tabs.ts toBrowserTabs; E13.diag.bootstrapTab); headless Chrome takes one target (chrome/app/chrome_main.cc ChromeMain) and no peer command opens a tab";
    for (const hypothesis of ["ops.tabs", "ops.marker", "t9.commands"])
      await recordUnavailable(await cellOf(hypothesis, topology), noTab);
    await record(
      "t9.exclusive",
      `${topology}; a running clone is asked for the other mode`,
      () => exclusiveSample(lab),
      1,
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
