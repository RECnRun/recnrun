// The capture benchmark held for 30 minutes (MANUAL_VALIDATION.md M-F3.a), run on demand only.
// Every `--flush-seconds` it appends a line to progress.jsonl, so a run cut short still reports.
import { appendFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runBench } from "./bench-capture.mjs";
import { sizeOf } from "./bench-probes.mjs";
import { parseBenchArgs, renderSummary } from "./bench-report.mjs";

// The benchmark's own options, passed on: --modes (default normal), --burst, --out.
const PASSED_ON = ["modes", "burst", "out"];
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    minutes: { type: "string", default: "30" },
    "flush-seconds": { type: "string", default: "60" },
    ...Object.fromEntries(PASSED_ON.map((name) => [name, { type: "string" }])),
  },
});
const minutes = Number(values.minutes);
const flushMs = Number(values["flush-seconds"]) * 1000;
if (!(minutes > 0) || !(flushMs > 0))
  throw new Error("--minutes and --flush-seconds need numbers.");
const rest = PASSED_ON.flatMap((name) =>
  values[name] === undefined ? [] : [`--${name}`, values[name]],
);
const options = parseBenchArgs(rest, { seconds: Math.round(minutes * 60), modes: "normal" });
const stamp = new Date().toISOString().replaceAll(":", "-");
const out = resolve(options.out ?? join(".artifacts", "soak", stamp));
await mkdir(out, { recursive: true });

const startedAt = Date.now();
let flushedAt = startedAt;
async function onCycle({ mode, counts, tally, folder }) {
  if (Date.now() - flushedAt < flushMs) return;
  flushedAt = Date.now();
  const totals = tally?.totals();
  const { heapUsed, rss } = process.memoryUsage();
  const line = {
    at: new Date().toISOString(),
    mode,
    elapsedSeconds: Math.round((flushedAt - startedAt) / 1000),
    ...counts,
    journaled: totals?.journaled ?? 0,
    gaps: totals?.gaps ?? {},
    heapUsedBytes: heapUsed,
    rssBytes: rss,
    traceBytes: await sizeOf(folder),
  };
  await appendFile(join(out, "progress.jsonl"), `${JSON.stringify(line)}\n`);
}

const { report } = await runBench({ ...options, out, heapEvents: 0 }, { kind: "soak", onCycle });
console.log(renderSummary(report));
console.log(`Report: ${join(out, "report.json")}; progress: ${join(out, "progress.jsonl")}`);
if (!report.checks.lossAccounted) process.exitCode = 2;
