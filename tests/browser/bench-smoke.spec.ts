import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures/chrome.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
// Three modes of 10 seconds: the plan's 30-second smoke run.
const SECONDS_PER_MODE = "10";
const HEAP_EVENTS = 50_000;

interface Outcome {
  code: number | null;
  output: string;
}

/** Runs the benchmark as its own Node process, so its heap holds the capture and nothing of Playwright. */
function runBench(out: string): Promise<Outcome> {
  const script = join(ROOT, "scripts/bench-capture.mjs");
  const args = ["--expose-gc", script, "--seconds", SECONDS_PER_MODE, "--out", out];
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (data) => (output += String(data)));
  child.stderr.on("data", (data) => (output += String(data)));
  return new Promise((resolve) => child.once("close", (code) => resolve({ code, output })));
}

interface ModeReport {
  mode: string;
  events: { journaled: number } | null;
  loss: {
    unaccountedInputs: number;
    accounted: boolean;
    sequence: { missing: number; overcounted: number };
  } | null;
}

test("the capture benchmark accounts every lost event as a gap and keeps memory bounded", async ({
  headless,
}, testInfo) => {
  expect(headless, "the benchmark drives headed Chrome").toBe(false);
  test.setTimeout(300_000);
  const out = testInfo.outputPath("bench");
  const { code, output } = await runBench(out);
  await testInfo.attach("output", { body: output, contentType: "text/plain" });
  const report = JSON.parse(await readFile(join(out, "report.json"), "utf8"));
  await testInfo.attach("report.json", { path: join(out, "report.json") });
  expect(await readFile(join(out, "summary.md"), "utf8")).toContain("Capture benchmark");
  const modes = report.modes as ModeReport[];
  expect(modes.map(({ mode }) => mode)).toEqual(["none", "normal", "deep"]);
  expect(modes[0]?.loss, "nothing is captured without instrumentation").toBeNull();
  for (const { mode, events, loss } of modes.slice(1)) {
    expect(events?.journaled, mode).toBeGreaterThan(0);
    expect(loss?.unaccountedInputs, `${mode}: inputs neither journaled nor in a gap`).toBe(0);
    expect(loss?.sequence, mode).toMatchObject({ missing: 0, overcounted: 0 });
    expect(loss?.accounted, mode).toBe(true);
  }
  expect(report.memory).toMatchObject({ gcForced: true, withinBudget: true });
  expect(report.memory.events).toBeGreaterThanOrEqual(HEAP_EVENTS);
  expect(report.memory.heapGrowthBytes).toBeLessThanOrEqual(report.memory.budgetBytes);
  expect(report.checks).toEqual({ lossAccounted: true, memoryBounded: true });
  expect(code, output).toBe(0);
});
