import { describe, expect, test } from "vite-plus/test";
import { sampleMode, sized } from "./experiments/samples.ts";

describe("sampleMode", () => {
  test("is full unless RECNRUN_EXPERIMENT_SAMPLES asks for smoke", () => {
    expect(sampleMode({})).toBe("full");
    expect(sampleMode({ RECNRUN_EXPERIMENT_SAMPLES: "full" })).toBe("full");
    expect(sampleMode({ RECNRUN_EXPERIMENT_SAMPLES: "smoke" })).toBe("smoke");
  });
});

describe("sized", () => {
  test("takes the full count for evidence", () => {
    expect(sized(20, 1, {})).toBe(20);
  });

  test("takes the few count in a smoke run", () => {
    expect(sized(20, 1, { RECNRUN_EXPERIMENT_SAMPLES: "smoke" })).toBe(1);
    expect(sized(10, 2, { RECNRUN_EXPERIMENT_SAMPLES: "smoke" })).toBe(2);
  });

  test("defaults to one sample", () => {
    expect(sized(50, undefined, { RECNRUN_EXPERIMENT_SAMPLES: "smoke" })).toBe(1);
  });
});
