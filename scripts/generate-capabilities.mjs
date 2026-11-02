// Renders docs/poc/namespace-sessions/CAPABILITIES.md from the capabilities.json an experiment run wrote.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DOCS = join("docs", "poc", "namespace-sessions");
export const SOURCE = join(DOCS, "capabilities.json");
export const TARGET = join(DOCS, "CAPABILITIES.md");
const COMMAND = `node scripts/generate-capabilities.mjs ${SOURCE.split("\\").join("/")}`;
const DETAIL_LENGTH = 120;

/** SHA-256 of the JSON without formatting, so reformatting the committed file keeps the hash. */
export function canonicalHash(text) {
  return createHash("sha256")
    .update(JSON.stringify(JSON.parse(text)))
    .digest("hex");
}

const code = (text) => `\`${String(text).replaceAll("`", "'")}\``;
const cell = (text) => String(text).replaceAll("|", "\\|").replaceAll("\n", " ");

/** A Markdown table padded the way the repository's formatter pads it, so formatting is a no-op. */
function table(header, rows) {
  const all = [header, ...rows].map((row) => row.map(cell));
  const widths = header.map((_, column) => Math.max(3, ...all.map((row) => row[column].length)));
  const line = (row) => `| ${row.map((text, column) => text.padEnd(widths[column])).join(" | ")} |`;
  const separator = `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`;
  return [line(all[0]), separator, ...all.slice(1).map(line)].join("\n");
}

function summary(detail) {
  if (detail === undefined || detail === null) return "";
  const text = JSON.stringify(detail);
  return code(text.length > DETAIL_LENGTH ? `${text.slice(0, DETAIL_LENGTH)}...` : text);
}

/** The first sample's detail; capabilities.json keeps every sample's. */
function firstDetail(probe) {
  const details = probe.details ?? [];
  const text = summary(details[0]);
  const first = JSON.stringify(details[0] ?? null);
  const differs = details.some((detail) => JSON.stringify(detail ?? null) !== first);
  return differs ? `${text} (samples differ)`.trim() : text;
}

function statusOf(probe) {
  const statuses = probe.statuses ?? [];
  const uniform = statuses.every((status) => status === statuses[0]);
  return uniform ? probe.status : `${probe.status} (${statuses.join(", ")})`;
}

function probeRows(probes) {
  return Object.entries(probes).map(([id, probe]) => [
    code(id),
    probe.description ?? "",
    statusOf(probe),
    String(probe.statuses?.length ?? 0),
    probe.error ? code(probe.error) : firstDetail(probe),
  ]);
}

const list = (values) => (values?.length ? values.map(code).join(", ") : "none");

/** The Markdown for one capabilities.json; `text` is its source, for the footer hash. */
export function renderCapabilities(text) {
  const capabilities = JSON.parse(text);
  const probe = capabilities.debuggerProbe ?? {};
  const load = capabilities.extensionLoad ?? {};
  const facts = table(
    ["Fact", "Value"],
    [
      ["Chrome", capabilities.chrome?.version ?? "unknown"],
      ["Probed on", probe.date ?? "unknown"],
      ["Extension load method", load.method ? code(load.method) : "unknown"],
      ["Permissions", list(probe.permissions)],
      ["Host permissions", list(probe.hostPermissions)],
      ["Samples per probe", String(probe.samples ?? "unknown")],
    ],
  );
  const probes = table(
    ["Probe", "Hypothesis", "Status", "Samples", "Exact error, or result of the first sample"],
    probeRows(capabilities.debugger ?? {}),
  );
  return [
    "# Chrome capabilities",
    "",
    `Generated from [capabilities.json](capabilities.json) by \`${COMMAND}\`; do not edit by hand. \`vp run docs:check\` fails when this file is stale. The probes and their reading are in [experiments/E1.md](experiments/E1.md). A status is what the isolator observed from inside the extension: \`allowed\` (the call answered and its observable effect happened, or the hypothesis held), \`rejected\` (Chrome refused, with its exact error, or Chrome accepted the call without the effect, or the hypothesis did not hold, with what did not happen), \`unavailable\` (a precondition was missing). capabilities.json keeps every sample's detail; the table shows the first.`,
    "",
    facts,
    "",
    "## chrome.debugger probes",
    "",
    probes,
    "",
    `Source: SHA-256 of the canonical JSON (\`JSON.stringify\` without whitespace) of capabilities.json: \`${canonicalHash(text)}\`.`,
    "",
  ].join("\n");
}

/** The newest capabilities.json with debugger probes, from local or Docker evidence. */
function newestEvidence(root) {
  const evidence = join(root, ".artifacts", "evidence");
  const docker = join(root, ".artifacts", "docker");
  const runs = (directory) =>
    existsSync(directory) ? readdirSync(directory).map((name) => join(directory, name)) : [];
  const candidates = [
    ...runs(evidence),
    ...runs(docker).flatMap((run) => runs(join(run, "evidence"))),
  ]
    .map((run) => join(run, "capabilities.json"))
    .filter((file) => existsSync(file) && "debugger" in JSON.parse(readFileSync(file, "utf8")))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0];
}

/** docs:check: the committed CAPABILITIES.md equals a fresh rendering of the committed JSON. */
export function checkCapabilities({ root }) {
  const source = join(root, SOURCE);
  if (!existsSync(source)) return [];
  const target = join(root, TARGET);
  const expected = renderCapabilities(readFileSync(source, "utf8"));
  if (existsSync(target) && readFileSync(target, "utf8") === expected) return [];
  return [`${TARGET}:1: stale; run \`${COMMAND}\``];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const source = process.argv[2] ? resolve(process.argv[2]) : newestEvidence(root);
  if (!source) throw new Error("No capabilities.json with debugger probes under .artifacts/");
  const text = readFileSync(source, "utf8");
  if (resolve(source) !== join(root, SOURCE)) writeFileSync(join(root, SOURCE), text);
  writeFileSync(join(root, TARGET), renderCapabilities(text));
  console.log(`Rendered ${TARGET} from ${relative(root, source)}.`);
}
