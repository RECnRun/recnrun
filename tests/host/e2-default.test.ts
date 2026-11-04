import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { UnavailableError } from "../browser/fixtures/policy-install.ts";
import { E2_CELLS } from "../experiments/fixtures/downloads-e2.ts";
import { host } from "./fixtures/downloads.ts";

// With the P2.2 presence, Chrome's real default would get ~/Downloads/RECnRun/poc/lab/peers/.
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("E2.location.default on the host", () => {
  test("is unavailable before any root or Chrome", async () => {
    // Without roots, reaching the launch would throw requireHost's error instead.
    vi.stubEnv("RECNRUN_HOST_ROOTS", "");
    const cell = E2_CELLS["E2.location.default"];
    if (!cell) throw new Error("E2 has no default-location cell");
    const refused = cell(host);
    await expect(refused).rejects.toBeInstanceOf(UnavailableError);
    await expect(refused).rejects.toThrow(
      "the POC presence would write outside the allowed Downloads subtree",
    );
  });
});
