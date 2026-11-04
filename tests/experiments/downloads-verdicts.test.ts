import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { judged, recordE2 } from "./fixtures/downloads-verdicts.ts";
import type { VerdictTarget } from "./fixtures/downloads-verdicts.ts";
import { readVerdicts } from "./verdicts.ts";

// Codex P1 finding 9: E2 records through outcome.ts, with gestures, steps, and the sample mode.
let directory = "";
const ESCAPE = 'xdotool: Escape in the "Save File" dialog';

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "recnrun-e2-verdicts-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

const host = (): VerdictTarget => ({
  environment: "host",
  chrome: () => Promise.resolve("Google Chrome 156.0.8078.80"),
  directory: () => directory,
});

describe("recordE2", () => {
  test("a host smoke run stamps mode smoke and keeps the gestures a sample needed", async () => {
    vi.stubEnv("RECNRUN_EXPERIMENT_SAMPLES", "smoke");
    const take = () => Promise.resolve(judged([], { title: "Save File" }, [ESCAPE]));
    await recordE2("E2.saveAs.prompt", host(), take);
    const [verdict, ...rest] = await readVerdicts(directory);
    expect(rest).toEqual([]);
    expect(verdict).toMatchObject({
      experiment: "E2",
      hypothesis: "E2.saveAs.prompt",
      environment: "host",
      verdict: "pass",
      samples: 1,
      mode: "smoke",
      gestures: 1,
      steps: [ESCAPE],
    });
  });

  test("a full run takes three samples, records zero gestures, and has no mode", async () => {
    vi.stubEnv("RECNRUN_EXPERIMENT_SAMPLES", "");
    const take = () => Promise.resolve(judged(["the probe failed: x"], { state: "interrupted" }));
    await recordE2("E2.write.completes", host(), take);
    const [verdict] = await readVerdicts(directory);
    expect(verdict).toMatchObject({ verdict: "fail", samples: 3, gestures: 0, steps: [] });
    expect(verdict).not.toHaveProperty("mode");
  });
});
