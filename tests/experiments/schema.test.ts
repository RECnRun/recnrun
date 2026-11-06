import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import { Cell, Gestures, VersionsFile, parseVerdicts } from "./schema.ts";

const verdictsDirectory = "../../docs/poc/downloads-launcher/experiments/verdicts/";

function committed(name: string): unknown {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(verdictsDirectory + name, import.meta.url)), "utf8"),
  );
}

const valid = {
  experiment: "E0",
  hypothesis: "E0.loadUnpacked",
  verdict: "pass",
  chrome: "Google Chrome 156.0.8078.79",
  environment: "lab",
  install: "loadUnpacked",
  label: "diagnostic",
  externalClient: true,
  variant: "test",
  topology: "single-root",
  debugger: "none",
  samples: 1,
};

function without(key: string): Record<string, unknown> {
  const { [key]: _omitted, ...rest } = valid as Record<string, unknown>;
  return rest;
}

describe("committed lab verdicts", () => {
  test("the full and smoke files parse", () => {
    expect(parseVerdicts(committed("E0-lab-full.json"))).toHaveLength(3);
    expect(parseVerdicts(committed("E0-lab-smoke.json"))).toHaveLength(3);
  });

  test("the E1 lab and host files parse, one verdict per hypothesis", () => {
    expect(parseVerdicts(committed("E1-lab-full.json"))).toHaveLength(8);
    expect(parseVerdicts(committed("E1-lab-smoke.json"))).toHaveLength(8);
    expect(parseVerdicts(committed("E1-host.json"))).toHaveLength(9);
    expect(() => v.parse(VersionsFile, committed("E1-lab-versions.json"))).not.toThrow();
  });

  test("the versions file parses", () => {
    expect(() => v.parse(VersionsFile, committed("E0-lab-versions.json"))).not.toThrow();
  });
});

describe("parseVerdicts", () => {
  test("accepts a minimal verdict", () => {
    expect(parseVerdicts([valid])).toHaveLength(1);
  });

  test.each(["environment", "install"])("refuses a verdict without %s, naming it", (key) => {
    expect(() => parseVerdicts([without(key)])).toThrow(new RegExp(key));
  });

  test("refuses an unknown verdict value", () => {
    expect(() => parseVerdicts([{ ...valid, verdict: "maybe" }])).toThrow(/verdict/);
  });

  test("refuses an extra key", () => {
    expect(() => parseVerdicts([{ ...valid, surprise: 1 }])).toThrow(/surprise/);
  });

  test("accepts an unavailable verdict with no sample when it names the reason", () => {
    const unavailable = { ...valid, verdict: "unavailable", samples: 0, error: "needs root" };
    expect(parseVerdicts([unavailable])).toHaveLength(1);
  });

  test("refuses an unavailable verdict without a reason", () => {
    expect(() => parseVerdicts([{ ...valid, verdict: "unavailable", samples: 0 }])).toThrow(
      /error/,
    );
    const blank = { ...valid, verdict: "unavailable", samples: 0, error: "" };
    expect(() => parseVerdicts([blank])).toThrow(/error/);
  });

  test("refuses a strict label with an external client or a loadUnpacked install", () => {
    const strict = { ...valid, label: "strict", install: "managed-policy", externalClient: false };
    expect(parseVerdicts([strict])).toHaveLength(1);
    expect(() => parseVerdicts([{ ...strict, externalClient: true }])).toThrow(/strict/);
    expect(() => parseVerdicts([{ ...strict, install: "loadUnpacked" }])).toThrow(/strict/);
  });

  test("puts no extra constraint on a diagnostic label", () => {
    const diagnostic = { ...valid, install: "managed-policy", externalClient: false };
    expect(parseVerdicts([diagnostic])).toHaveLength(1);
  });

  test("accepts the gestures and steps of a verdict and refuses negative gestures", () => {
    const toggled = { ...valid, gestures: 2, steps: ["xdotool: Developer mode on"] };
    expect(parseVerdicts([toggled])).toHaveLength(1);
    expect(() => parseVerdicts([{ ...toggled, gestures: -1 }])).toThrow(/gestures/);
    expect(() => parseVerdicts([{ ...toggled, steps: [1] }])).toThrow(/steps/);
  });

  test.each(["pass", "fail"])("refuses a %s verdict with no sample", (verdict) => {
    expect(() => parseVerdicts([{ ...valid, verdict, samples: 0 }])).toThrow(/samples/);
  });
});

describe("Gestures", () => {
  test("refuses negative gestures", () => {
    expect(() => v.parse(Gestures, { cell: "c", gestures: -1, steps: [] })).toThrow();
    expect(() => v.parse(Gestures, { cell: "c", gestures: 0, steps: ["open"] })).not.toThrow();
  });
});

describe("Cell", () => {
  const cell = {
    environment: "host",
    install: "load-unpacked-gesture",
    variant: "poc-d0",
    topology: "two-roots",
    debugger: "declared",
    roots: ["a", "b"],
    downloadsLayout: "shared",
    operation: "download",
    clone: false,
    templateState: "frozen",
  };

  test("accepts a complete cell and refuses an unknown template state", () => {
    expect(() => v.parse(Cell, cell)).not.toThrow();
    expect(() => v.parse(Cell, { ...cell, templateState: "stale" })).toThrow();
  });
});
