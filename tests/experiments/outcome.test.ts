import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { UnavailableError } from "../browser/fixtures/policy-install.ts";
import { expectEveryHypothesis, recordHypothesis } from "./outcome.ts";
import type { Cell } from "./outcome.ts";
import { readVerdicts } from "./verdicts.ts";

// Codex P1 finding 5: a harness error fails the test; only a measurement that ran becomes a sample.
let directory = "";
const cell: Cell = {
  experiment: "EX",
  hypothesis: "EX.measured",
  chrome: "Google Chrome 156.0.8078.80",
  environment: "lab",
  install: "loadUnpacked",
  label: "diagnostic",
  externalClient: true,
  variant: "poc-d0",
  topology: "single-root",
  debugger: "none",
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "recnrun-outcome-"));
  vi.stubEnv("RECNRUN_EXPERIMENT_SAMPLES", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe("recordHypothesis", () => {
  test("a setup error propagates and leaves no verdict", async () => {
    const take = () => Promise.reject(new Error("diagnostics page never started"));
    await expect(recordHypothesis(cell, take, { directory })).rejects.toThrow(
      "diagnostics page never started",
    );
    expect(await readVerdicts(directory)).toEqual([]);
    await expect(expectEveryHypothesis("EX", ["EX.measured"], directory)).rejects.toThrow(
      /every hypothesis ran/,
    );
  });

  test("a setup error after a measured sample still propagates", async () => {
    let calls = 0;
    const take = () =>
      ++calls === 1
        ? Promise.resolve({ ok: true, observation: { read: true }, steps: [] })
        : Promise.reject(new Error("CDP connection closed"));
    await expect(recordHypothesis(cell, take, { directory })).rejects.toThrow("CDP connection");
    expect(await readVerdicts(directory)).toEqual([]);
  });

  test("a measured contradiction is a fail verdict with its observations", async () => {
    const take = () =>
      Promise.resolve({ ok: false, error: "fetch failed", observation: { read: false } });
    const verdict = await recordHypothesis(cell, take, { directory });
    expect(verdict).toMatchObject({ verdict: "fail", samples: 3, error: expect.any(String) });
    expect(verdict.observations).toEqual([{ read: false }, { read: false }, { read: false }]);
    await expect(expectEveryHypothesis("EX", ["EX.measured"], directory)).resolves.toBeUndefined();
  });

  test("a method that cannot run is unavailable with its reason and no sample", async () => {
    const take = () => Promise.reject(new UnavailableError("no display on the host"));
    const verdict = await recordHypothesis(cell, take, { directory });
    expect(verdict).toMatchObject({ verdict: "unavailable", samples: 0 });
    expect(verdict.error).toBe("no display on the host");
  });
});
