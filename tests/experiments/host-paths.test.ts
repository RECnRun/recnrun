import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { hostPathIn, labelPaths } from "./host-paths.ts";
import type { Cell } from "./outcome.ts";
import { appendVerdict } from "./verdicts.ts";
import type { Verdict } from "./verdicts.ts";

// Codex P4 finding 15: a host verdict names the run's folders by label, never by host path.
const ROOT = "/Users/someone/Documents/run/launcher-1";
const labels = [
  [ROOT, "<root>"],
  [`${ROOT}/home`, "<home>"],
  ["/Users/someone/Documents/run", "<evidence>"],
] as const;

describe("labelPaths", () => {
  test("replaces the longest path first in strings, arrays, and objects", () => {
    const sample = {
      error: `no ack under ${ROOT}/home/x and ${ROOT}/downloads`,
      stdout: [`root=${ROOT}\n`, "/Users/someone/Documents/run/evidence.json"],
      nested: { path: `${ROOT}/home`, count: 3, ok: true },
    };
    expect(labelPaths(sample, labels)).toEqual({
      error: "no ack under <home>/x and <root>/downloads",
      stdout: ["root=<root>\n", "<evidence>/evidence.json"],
      nested: { path: "<home>", count: 3, ok: true },
    });
  });
});

describe("hostPathIn", () => {
  test("finds a macOS or Linux home path and names it", () => {
    expect(hostPathIn("saw /Users/someone/Documents/x")).toBe("/Users/someone/Documents/x");
    expect(hostPathIn("at /home/runner/work")).toBe("/home/runner/work");
    expect(hostPathIn("saw <root>/downloads")).toBeUndefined();
  });
});

describe("appendVerdict on the host", () => {
  let directory = "";
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "recnrun-host-paths-"));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  const cell: Cell = {
    experiment: "EX",
    hypothesis: "EX.host",
    chrome: "Google Chrome 156.0.8078.80",
    environment: "host",
    install: "loadUnpacked",
    label: "diagnostic",
    externalClient: true,
    variant: "poc-d0",
    topology: "single-root",
    debugger: "none",
  };
  const verdict = (observation: Record<string, unknown>): Verdict => ({
    ...cell,
    verdict: "pass",
    samples: 1,
    gestures: 0,
    steps: [],
    observations: [observation],
  });

  test("rejects a host verdict that carries a host path", async () => {
    await expect(
      appendVerdict(verdict({ stderr: "saw /Users/someone/Documents/x" }), directory),
    ).rejects.toThrow(/host path/);
  });

  test("accepts a host verdict with labels only", async () => {
    await expect(
      appendVerdict(verdict({ stderr: "saw <root>/x" }), directory),
    ).resolves.toBeUndefined();
  });
});
