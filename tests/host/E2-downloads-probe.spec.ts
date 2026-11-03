import { expect, test } from "./fixtures/host-chrome.ts";
import { host, readHostVerdicts } from "./fixtures/downloads.ts";
import { E2_CELLS, missingVerdicts } from "../experiments/fixtures/downloads-e2.ts";
import { recordE2 } from "../experiments/fixtures/downloads-verdicts.ts";

// POC PLAN.md P1.3 on the installed Google Chrome of this Mac: E2's cells on throwaway roots.
test.describe("E2 host twin: probe write and real path", () => {
  test.describe.configure({ timeout: 600_000 });

  for (const [hypothesis, cell] of Object.entries(E2_CELLS)) {
    test(hypothesis, async () => {
      await recordE2(hypothesis, host.target, () => cell(host));
    });
  }

  test("every E2 hypothesis left a verdict", async () => {
    expect(missingVerdicts(await readHostVerdicts())).toEqual([]);
  });
});
