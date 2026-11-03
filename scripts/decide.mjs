// Prints, per capability, which route (A, B, C) passed, from the committed P1 verdicts.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CAPABILITIES, MAPPING, NOT_MAPPED, ROUTES, SPECS } from "./decide-mapping.mjs";

const EXPERIMENTS = join("docs", "poc", "namespace-sessions", "experiments");
const VERDICTS = join(EXPERIMENTS, "verdicts");
export const REPORT = join(EXPERIMENTS, "REPORT-P1.md");
export const START = "<!-- decide:start -->";
export const END = "<!-- decide:end -->";
const STATUSES = ["pass", "fail", "unavailable"];
const SUMMARY = ["pass", "mixed", "fail", "unavailable", "not tested"];
const UNMAPPED_REASON = "no mapping row";

const posix = (path) => path.split("\\").join("/");
const cell = (text) => String(text).replaceAll("|", "\\|").replaceAll("\n", " ");

/** A Markdown table padded the way the repository's formatter pads it, so formatting is a no-op. */
function table(header, rows) {
  const all = [header, ...rows].map((row) => row.map(cell));
  const widths = header.map((_, column) => Math.max(3, ...all.map((row) => row[column].length)));
  const line = (row) => `| ${row.map((text, column) => text.padEnd(widths[column])).join(" | ")} |`;
  const separator = `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`;
  return [line(all[0]), separator, ...all.slice(1).map(line)].join("\n");
}

function invalid(file, problem) {
  return new Error(`${posix(file)}: ${problem}`);
}

function checkVerdict(file, entry, index) {
  const at = `entry ${index}`;
  if (typeof entry !== "object" || entry === null) throw invalid(file, `${at} is not an object`);
  const { experiment, hypothesis, verdict, chrome, samples } = entry;
  const stem = file.replace(/^.*[\\/]/, "").replace(/\.json$/, "");
  if (typeof hypothesis !== "string") throw invalid(file, `${at} has no hypothesis`);
  if (experiment !== stem) throw invalid(file, `${at} belongs to ${experiment}, not ${stem}`);
  if (!STATUSES.includes(verdict)) throw invalid(file, `${at} has verdict ${verdict}`);
  if (typeof chrome !== "string") throw invalid(file, `${at} has no chrome version`);
  if (!Number.isFinite(samples)) throw invalid(file, `${at} has no samples count`);
  if (entry.mode !== undefined) {
    throw invalid(
      file,
      `${experiment} ${hypothesis} has mode "${entry.mode}"; smoke runs are never evidence`,
    );
  }
}

/** Reads verdicts/E<n>.json in order; each entry is returned with the file it came from. */
export function readVerdicts(root) {
  const directory = join(root, VERDICTS);
  if (!existsSync(directory)) throw invalid(VERDICTS, "no such directory");
  const files = readdirSync(directory)
    .filter((name) => /^E\d+\.json$/.test(name))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  return files.flatMap((name) => {
    const file = join(VERDICTS, name);
    let list;
    try {
      list = JSON.parse(readFileSync(join(root, file), "utf8"));
    } catch (error) {
      throw invalid(file, `unreadable JSON: ${error.message}`);
    }
    if (!Array.isArray(list)) throw invalid(file, "not an array of verdicts");
    return list.map((entry, index) => {
      checkVerdict(file, entry, index);
      return { file, verdict: entry };
    });
  });
}

function variantMatches(pattern, name) {
  return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

/** The status of one mapped hypothesis, or undefined when no verdict (or variant) matches the row. */
function resultOf(verdicts, row) {
  const found = verdicts.find(
    (entry) => entry.experiment === row.experiment && entry.hypothesis === row.hypothesis,
  );
  if (!found || row.variant === undefined) return found;
  const names = (found.variants ?? []).filter((entry) => variantMatches(row.variant, entry.name));
  if (!names.length) return undefined;
  const status = names.some((entry) => entry.verdict === "fail")
    ? "fail"
    : names.every((entry) => entry.verdict === "pass")
      ? "pass"
      : "unavailable";
  return { ...found, verdict: status };
}

const keyOf = (row) => [row.experiment, row.hypothesis, row.variant].filter(Boolean).join("/");

export function unmatchedRows(verdicts, mapping) {
  return mapping.filter((row) => !resultOf(verdicts, row));
}

export function unmappedVerdicts(verdicts, mapping) {
  return verdicts.filter(
    (entry) =>
      !mapping.some(
        (row) => row.experiment === entry.experiment && row.hypothesis === entry.hypothesis,
      ),
  );
}

function cellText(counts) {
  const total = STATUSES.reduce((sum, status) => sum + counts[status], 0);
  if (!total) return "not tested";
  const present = STATUSES.filter((status) => counts[status]);
  if (present.length === 1) return `${present[0]} (${total})`;
  return `mixed (${present.map((status) => `${counts[status]} ${status}`).join(", ")})`;
}

function cellStatus(text) {
  return SUMMARY.find((status) => text.startsWith(status));
}

function grid(rows) {
  const counts = (capability, route) => {
    const own = rows.filter(
      (row) => row.capability === capability && row.route === route && !row.label,
    );
    return Object.fromEntries(STATUSES.map((s) => [s, own.filter((r) => r.status === s).length]));
  };
  return CAPABILITIES.map((capability) => [
    capability,
    ...ROUTES.map((route) => cellText(counts(capability, route))),
  ]);
}

function chromeLine(verdicts) {
  const counts = new Map();
  for (const { chrome } of verdicts) counts.set(chrome, (counts.get(chrome) ?? 0) + 1);
  const listed = [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name} (${n} ${n === 1 ? "verdict" : "verdicts"})`);
  return `Chrome: ${listed.join("; ")}`;
}

function summaryRows(cells) {
  return ROUTES.map((route, column) => {
    const states = cells.map((row) => cellStatus(row[column + 1]));
    return [`Route ${route}`, ...SUMMARY.map((s) => String(states.filter((v) => v === s).length))];
  });
}

function evidenceRows(rows) {
  return rows.map((row) => {
    const hypothesis = [row.experiment, row.hypothesis, row.variant && `[${row.variant}]`];
    const status = row.label ? `${row.status} (${row.label})` : row.status;
    const reason = row.reason;
    return [
      row.capability,
      row.route,
      hypothesis.filter(Boolean).join(" "),
      status,
      row.spec,
      reason,
    ];
  });
}

function unmappedRows(entries) {
  const experiments = [...new Set(entries.map((entry) => entry.experiment))];
  return experiments.map((experiment) => {
    const own = entries.filter((entry) => entry.experiment === experiment);
    const count = (status) => String(own.filter((entry) => entry.verdict === status).length);
    return [
      experiment,
      String(own.length),
      ...STATUSES.map(count),
      NOT_MAPPED[experiment] ?? UNMAPPED_REASON,
    ];
  });
}

function stressSection(root) {
  const file = join(root, VERDICTS, "stress.json");
  if (!existsSync(file)) return ["stress: not recorded"];
  const stress = JSON.parse(readFileSync(file, "utf8"));
  const failed = stress.failedIterations.length;
  const rows = Object.entries(stress.perHypothesis).map(([name, entry]) => [
    name,
    ...["pass", "fail", "unavailable", "lateAttaches"].map((key) => String(entry[key])),
  ]);
  const head = `stress: ${stress.iterations} of ${stress.requested} iterations, ${failed} failed`;
  return [head, "", table(["Hypothesis", "Pass", "Fail", "Unavailable", "Late attaches"], rows)];
}

/** Renders the decision tables for the verdicts committed under root. */
export function decide(root, mapping = MAPPING) {
  const entries = readVerdicts(root);
  const verdicts = entries.map((entry) => entry.verdict);
  for (const row of unmatchedRows(verdicts, mapping)) {
    throw new Error(`mapping row ${keyOf(row)} matches no verdict`);
  }
  const rows = mapping.map((row) => ({
    ...row,
    status: resultOf(verdicts, row).verdict,
    label: resultOf(verdicts, row).label ?? row.label,
    spec: SPECS[row.experiment] ?? "",
  }));
  const cells = grid(rows);
  const routeHeader = ROUTES.map((route) => `Route ${route}`);
  return [
    chromeLine(verdicts),
    "",
    "**Which route passed, per capability**",
    "",
    table(["Capability", ...routeHeader], cells),
    "",
    "**Capabilities per route**",
    "",
    table(["Route", ...SUMMARY.map((s) => s[0].toUpperCase() + s.slice(1))], summaryRows(cells)),
    "",
    "**Evidence behind each cell** (diagnostic, control, and supporting rows are not counted)",
    "",
    table(["Capability", "Route", "Hypothesis", "Verdict", "Spec", "Reason"], evidenceRows(rows)),
    "",
    "**Not mapped to a capability**",
    "",
    table(
      ["Experiment", "Verdicts", "Pass", "Fail", "Unavailable", "Reason"],
      unmappedRows(unmappedVerdicts(verdicts, mapping)),
    ),
    "",
    ...stressSection(root),
  ].join("\n");
}

/** Replaces the block between the markers of REPORT-P1.md with a fresh run. */
export function writeReport(root, mapping = MAPPING) {
  const file = join(root, REPORT);
  const text = readFileSync(file, "utf8");
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start < 0 || end < start) throw invalid(REPORT, `needs ${START} and ${END}`);
  const block = `${START}\n${decide(root, mapping)}\n`;
  writeFileSync(file, text.slice(0, start) + block + text.slice(end));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const root = resolve(
    args.find((arg) => !arg.startsWith("--")) ?? fileURLToPath(new URL("..", import.meta.url)),
  );
  try {
    if (args.includes("--write")) writeReport(root);
    else console.log(decide(root));
  } catch (error) {
    console.error(`decide: ${posix(error.message.replace(`${root}/`, ""))}`);
    process.exitCode = 1;
  }
}
