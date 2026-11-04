import { test } from "../browser/fixtures/chrome.ts";
import { extensionPath } from "../browser/fixtures/extension-loaders.ts";
import { E7_CELLS, e7Cell, presenceCostSample } from "./e7-samples.ts";
import type { E7Hypothesis } from "./e7-samples.ts";
import { requireBuild } from "./file-access.ts";
import { expectEveryHypothesis, recordHypothesis } from "./outcome.ts";

const TITLES: Record<E7Hypothesis, string> = {
  "E7.baseline": "count half-TTL renewals and history items",
  "E7.variant.linkedSilence": "leave liveness to linked DataChannels",
  "E7.variant.heartbeat": "renew only after a TTL without a heartbeat",
  "E7.variant.launcherPresence": "leave the presence to a launcher stand-in",
  "E7.newcomer.linkedSilence": "a fresh profile after every presence expired, linked silence",
  "E7.newcomer.heartbeat": "a fresh profile after every presence expired, heartbeat",
};

test.describe("E7: presence cost with five profiles in Docker", () => {
  test.describe.configure({ timeout: 1_200_000 });
  test.beforeAll(async () => requireBuild(extensionPath("poc-d0"), "poc-d0"));

  for (const hypothesis of E7_CELLS) {
    test(`${hypothesis}: ${TITLES[hypothesis]}`, async () => {
      await recordHypothesis(await e7Cell(hypothesis), () => presenceCostSample(hypothesis));
    });
  }

  test("every E7 hypothesis left a verdict", async () => expectEveryHypothesis("E7", E7_CELLS));
});
