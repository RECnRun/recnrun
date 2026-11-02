import type { Capability, CapabilityMatrix } from "../src/index.ts";

const HEADERS = ["Id", "Title", "Status", "Phase", "Notes"];

function cells(entry: Capability): string[] {
  return [entry.id, entry.title, entry.status, entry.phase, entry.notes].map((text) =>
    text.replaceAll("|", "\\|"),
  );
}

// Padded like the formatter pads Markdown tables, so `vp check` leaves the file unchanged.
function table(rows: string[][]): string[] {
  const widths = HEADERS.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const line = (row: string[]) =>
    `| ${row.map((text, column) => text.padEnd(widths[column] ?? 0)).join(" | ")} |`;
  const rule = `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`;
  return [line(HEADERS), rule, ...rows.map(line)];
}

const SECTIONS = [
  { kind: "surface", heading: "Capture surfaces" },
  { kind: "feature", heading: "Features" },
] as const;

/** Renders the matrix as docs/CAPABILITIES.md: one table per kind, sorted by id. */
export function renderCapabilitiesMarkdown(matrix: CapabilityMatrix): string {
  const lines = [
    "# Capabilities",
    "",
    "<!-- Generated from packages/protocol/src/capability-matrix.ts. Do not edit. -->",
    "",
    "This file is generated from the capability matrix in `packages/protocol`. Edit the matrix, then run `vp run capabilities:generate`; `vp run docs:check` fails when this file is stale. Status moves only with a test that shows the new behavior ([PLAN.md](plan/PLAN.md#7-working-rules-specific-to-this-plan)).",
    "",
    "Statuses: `implemented` (proved by a test), `partial` (works with a stated limit), `unavailable` (cannot be done, and the limit is stated), `planned` (not built yet).",
  ];
  for (const { kind, heading } of SECTIONS) {
    const rows = matrix.capabilities
      .filter((entry) => entry.kind === kind)
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(cells);
    lines.push("", `## ${heading}`, "", ...table(rows));
  }
  return `${lines.join("\n")}\n`;
}
