import { test } from "../browser/fixtures/chrome.ts";
import { extensionPath } from "../browser/fixtures/extension-loaders.ts";
import { E7_CELLS, e7Cell, presenceCostSample } from "./e7-samples.ts";
import { requireBuild } from "./file-access.ts";
import { expectEveryHypothesis, recordHypothesis, recordUnavailable } from "./outcome.ts";
import { readVerdicts } from "./verdicts.ts";

test.describe("E7: presence cost with five profiles in Docker", () => {
  test.describe.configure({ timeout: 1_200_000 });
  test.beforeAll(async () => requireBuild(extensionPath("poc-d0"), "poc-d0"));

  test("E7.baseline: count half-TTL renewals and history items", async () => {
    await recordHypothesis(await e7Cell("E7.baseline"), () => presenceCostSample(false));
  });

  test("E7.variant.linkedSilence: leave liveness to linked DataChannels", async () => {
    await recordHypothesis(await e7Cell("E7.variant.linkedSilence"), () =>
      presenceCostSample(true),
    );
  });

  for (const hypothesis of ["E7.variant.heartbeat", "E7.variant.launcherPresence"] as const) {
    test(`${hypothesis}: apply the owner's conditional scope rule`, async () => {
      const linked = (await readVerdicts()).find(
        (entry) => entry.hypothesis === "E7.variant.linkedSilence",
      );
      if (!linked || linked.samples === 0)
        throw new Error("Measure linkedSilence before deciding the conditional cells.");
      const rates = (linked.observations ?? []).map((observation) => {
        const total = (observation as { total?: { downloadsPerHour?: unknown } }).total;
        if (typeof total?.downloadsPerHour !== "number")
          throw new Error("Missing linkedSilence rate.");
        return total.downloadsPerHour;
      });
      if (rates.length === 0 || rates.some((rate) => rate > 100))
        throw new Error(
          "linkedSilence exceeds 100 items/hour: implement and measure the remaining variants.",
        );
      await recordUnavailable(
        await e7Cell(hypothesis),
        `Owner-approved scope: linkedSilence measured ${rates.join(", ")} downloads/hour with five profiles (at most 100); this variant is not implemented or measured.`,
      );
    });
  }

  test("every E7 hypothesis left a verdict", async () => expectEveryHypothesis("E7", E7_CELLS));
});
