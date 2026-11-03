// Pure parts of the capture benchmark: arguments, loss arithmetic, percentiles, and the report.
import { parseArgs } from "node:util";

/**
 * What the Node heap may grow, after a forced GC, from before the capture started to 50 000
 * events captured with the capture still live. Measured 2026-11-03 in the test container
 * (Node 24.21, Chrome 156): 0.4 to 3.4 MB of growth over a 50 to 60 MB baseline of loaded
 * modules that drifts between runs, which is why the budget bounds the growth. A capture that
 * kept its events grew it by 31 MB (some 600 bytes each), measured with a retaining sink.
 */
export const HEAP_GROWTH_BUDGET_BYTES = 16 * 1024 * 1024;
const MODES = ["none", "normal", "deep"];
const UI_PROGRESS_TARGET_MS = 1_000;
const RECORDING_TARGET_SECONDS = 30 * 60;

const rank = (sorted, quantile) => {
  const value = sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)];
  return Math.round(value * 100) / 100;
};

/** Nearest-rank p50 and p95 of the samples; null when there are none. */
export function percentiles(samples) {
  if (samples.length === 0) return { samples: 0, p50: null, p95: null, max: null };
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50: rank(sorted, 0.5),
    p95: rank(sorted, 0.95),
    max: rank(sorted, 1),
  };
}

/** Pairs the page's click times with the journal's, in order, and summarizes the delays. */
export function pairLags(pageTimes, journalTimes) {
  const count = Math.min(pageTimes.length, journalTimes.length);
  return percentiles(pageTimes.slice(0, count).map((at, index) => journalTimes[index] - at));
}

const isHook = (producer) => typeof producer === "string" && producer.startsWith("hook:");

/** Counts journaled events per hook producer without keeping them, so memory stays flat. */
export function createLossTally() {
  const producers = new Map();
  const gaps = {};
  let journaled = 0;
  let journaledInputs = 0;
  const of = (producer) => {
    if (!producers.has(producer)) producers.set(producer, { delivered: 0, lost: 0, highest: 0 });
    return producers.get(producer);
  };
  const addGap = ({ type, payload }) => {
    gaps[type] = (gaps[type] ?? 0) + 1;
    if (!isHook(payload.producer)) return;
    const entry = of(payload.producer);
    entry.lost += Number(payload.lost ?? 0);
    entry.highest = Math.max(entry.highest, Number(payload.toSeq ?? 0));
  };
  return {
    add(event) {
      journaled += 1;
      if (event.category === "gap") addGap(event);
      // The hook numbers its own loss reports, so a gap it sent is a delivery too.
      if (!isHook(event.producer)) return;
      const entry = of(event.producer);
      entry.delivered += 1;
      entry.highest = Math.max(entry.highest, event.seq);
      if (event.category === "dom" && event.type === "input") journaledInputs += 1;
    },
    totals: () => ({ journaled, journaledInputs, producers: [...producers.values()], gaps }),
  };
}

/** Loss of one mode: what the page dispatched against what the journal delivered or a gap named. */
export function accountLoss(totals, pageInputs) {
  const sum = (pick) => totals.producers.reduce((total, entry) => total + pick(entry), 0);
  const balance = ({ highest, delivered, lost }) => highest - delivered - lost;
  const gapLost = sum(({ lost }) => lost);
  const sequence = {
    producers: totals.producers.length,
    delivered: sum(({ delivered }) => delivered),
    lost: gapLost,
    highest: totals.producers.reduce((top, { highest }) => Math.max(top, highest), 0),
    missing: sum((entry) => Math.max(0, balance(entry))),
    overcounted: sum((entry) => Math.max(0, -balance(entry))),
  };
  const unaccountedInputs = Math.max(0, pageInputs - totals.journaledInputs - gapLost);
  return {
    pageInputs,
    journaledInputs: totals.journaledInputs,
    gapLost,
    unaccountedInputs,
    sequence,
    gaps: totals.gaps,
    accounted: unaccountedInputs === 0 && sequence.missing === 0 && sequence.overcounted === 0,
  };
}

export function checkBudget(heapUsedBytes, heapBeforeBytes) {
  const heapGrowthBytes = heapUsedBytes - heapBeforeBytes;
  return {
    budgetBytes: HEAP_GROWTH_BUDGET_BYTES,
    heapBeforeBytes,
    heapUsedBytes,
    heapGrowthBytes,
    headroomBytes: HEAP_GROWTH_BUDGET_BYTES - heapGrowthBytes,
    withinBudget: heapGrowthBytes <= HEAP_GROWTH_BUDGET_BYTES,
  };
}

function positive(name, value, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    throw new Error(`--${name} needs a positive integer.`);
  return number;
}

function modesOf(value) {
  if (value === undefined) return MODES;
  const modes = value.split(",").filter(Boolean);
  const unknown = modes.find((mode) => !MODES.includes(mode));
  if (unknown !== undefined) throw new Error(`Unknown mode ${unknown}; use ${MODES.join(", ")}.`);
  return modes;
}

/** `--seconds` per mode, `--burst` input events per click, `--modes`, `--heap-events`, `--out`. */
export function parseBenchArgs(argv, defaults = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      seconds: { type: "string" },
      burst: { type: "string" },
      modes: { type: "string" },
      "heap-events": { type: "string" },
      out: { type: "string" },
    },
  });
  return {
    seconds: positive("seconds", values.seconds, defaults.seconds ?? 30),
    burst: positive("burst", values.burst, 500),
    modes: modesOf(values.modes ?? defaults.modes),
    heapEvents: positive("heap-events", values["heap-events"], defaults.heapEvents ?? 50_000),
    out: values.out,
  };
}

const recordingModes = (modes) => modes.filter((mode) => mode.loss !== null);

function targetsOf(modes) {
  const recorded = recordingModes(modes);
  const normal = recorded.find(({ mode }) => mode === "normal") ?? recorded[0];
  const lags = recorded.filter((mode) => mode.journalLagMs);
  return [
    {
      id: "ui-progress",
      description:
        "Interaction journaled, so the UI can show it, within 1 s (p95 click to journal)",
      targetMs: UI_PROGRESS_TARGET_MS,
      measured: Object.fromEntries(lags.map(({ mode, journalLagMs }) => [mode, journalLagMs.p95])),
    },
    {
      id: "recording-30-minutes",
      description: "A 30-minute recording; the soak (scripts/soak-capture.mjs) runs it in full",
      targetSeconds: RECORDING_TARGET_SECONDS,
      measuredSeconds: Math.max(0, ...recorded.map(({ seconds }) => seconds)),
      projectedTraceBytes: normal ? normal.trace.bytesPerSecond * RECORDING_TARGET_SECONDS : null,
    },
  ];
}

/** The report written to report.json; targets are measurements, the checks are the gates. */
export function shapeReport({ kind = "bench", options, versions, modes, memory, ...times }) {
  return {
    schemaVersion: 1,
    kind,
    ...times,
    options,
    versions,
    modes,
    memory,
    targets: targetsOf(modes),
    checks: {
      lossAccounted: recordingModes(modes).every(({ loss }) => loss.accounted),
      memoryBounded: memory ? memory.withinBudget : null,
    },
  };
}

const cell = (value) => (value === null || value === undefined ? "n/a" : String(value));
const yesNo = (value) => (value === null ? "not measured" : value ? "yes" : "no");

function modeRow({ mode, latencyMs, journalLagMs, events, loss, node, chrome, trace }) {
  return `| ${[
    mode,
    cell(latencyMs?.click.p95),
    cell(latencyMs?.key.p95),
    cell(journalLagMs?.p95),
    cell(events?.perSecond),
    loss ? `${loss.gapLost}/${loss.unaccountedInputs}` : "n/a",
    cell(node?.cpuPercent),
    cell(chrome?.cpuSeconds),
    cell(trace?.totalBytes),
  ].join(" | ")} |`;
}

/** A short Markdown summary beside report.json. */
export function renderSummary(report) {
  const memory = report.memory;
  return [
    `# Capture benchmark (${report.kind})`,
    "",
    `Chrome ${cell(report.versions.chrome)}, Node ${cell(report.versions.node)}, image ${cell(report.versions.imageId)}.`,
    "",
    "| Mode | Click p95 ms | Key p95 ms | Journal lag p95 ms | Events/s | Lost in gaps/unaccounted | Node CPU % | Chrome CPU s | Trace bytes |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.modes.map(modeRow),
    "",
    `- loss accounted: ${yesNo(report.checks.lossAccounted)}`,
    `- memory bounded: ${yesNo(report.checks.memoryBounded)}${memory ? ` (heap grew ${memory.heapGrowthBytes} of ${memory.budgetBytes} bytes over ${memory.events} events)` : ""}`,
    ...report.targets.map((target) => `- target ${target.id}: ${JSON.stringify(target)}`),
    "",
  ].join("\n");
}
