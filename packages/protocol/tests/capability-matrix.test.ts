import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import { renderCapabilitiesMarkdown } from "../scripts/render-capabilities.ts";
import {
  CAPABILITY_MATRIX,
  CAPTURE_LEVELS,
  CAPTURE_SURFACES,
  CapabilityMatrixSchema,
} from "../src/index.ts";

const entries = CAPABILITY_MATRIX.capabilities;

test("the matrix parses with its schema", () => {
  expect(v.safeParse(CapabilityMatrixSchema, CAPABILITY_MATRIX).success).toBe(true);
  expect(entries.length).toBeGreaterThan(0);
});

test("ids are unique", () => {
  const ids = entries.map((entry) => entry.id);
  expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
});

test.each(CAPTURE_SURFACES)("the surface %s has at least one entry", (surface) => {
  const found = entries.filter((entry) => entry.kind === "surface" && entry.surface === surface);
  expect(found.length).toBeGreaterThan(0);
});

test("both capture levels are described", () => {
  for (const level of CAPTURE_LEVELS) {
    expect(entries.some((entry) => entry.kind === "surface" && entry.level === level)).toBe(true);
  }
});

test("every phase is a task id of the plan", () => {
  expect(entries.length).toBeGreaterThan(0);
  for (const entry of entries) expect(entry.phase).toMatch(/^F\d[A]?\.\d+$/);
});

test("an implemented entry names the task or test that proves it", () => {
  const implemented = entries.filter((entry) => entry.status === "implemented");
  expect(implemented.length).toBeGreaterThan(0);
  for (const entry of implemented) {
    expect(entry.notes, entry.id).toMatch(/\bF\d[A]?\.\d+\b|\.test\./);
  }
});

test("a capture surface stays planned until a test proves it", () => {
  const surfaces = entries.filter((entry) => entry.kind === "surface");
  expect(surfaces.length).toBeGreaterThan(0);
  expect(surfaces.filter((entry) => entry.status !== "planned")).toEqual([]);
});

test("the rendered document is deterministic, sorted, and lists every entry", () => {
  const text = renderCapabilitiesMarkdown(CAPABILITY_MATRIX);
  expect(renderCapabilitiesMarkdown(CAPABILITY_MATRIX)).toBe(text);
  for (const entry of entries) expect(text).toContain(`| ${entry.id} `);
  const surfaceIds =
    text
      .split("## Features")[0]
      ?.match(/^\| [\w.-]+ /gm)
      ?.slice(2) ?? [];
  expect(surfaceIds).toEqual(surfaceIds.toSorted());
});

test("every F0 deliverable is implemented", () => {
  const f0 = [
    "docs-link-check",
    "workspace-skeleton",
    "protocol-schemas",
    "capability-matrix",
    "fixture-app",
    "chrome-in-docker",
  ];
  const byId = new Map(entries.map((entry) => [entry.id, entry.status]));
  for (const id of f0) {
    expect(byId.get(id), id).toBe("implemented");
  }
});

test.each([
  ["chrome-discovery", "implemented", "tests/browser/discover.spec.ts"],
  ["cdp-connection", "implemented", "tests/browser/connect.spec.ts"],
  ["connection-loss-reconnect", "implemented", "tests/browser/connect.spec.ts"],
  ["contested-control", "partial", "tests/browser/connect.spec.ts"],
])("the F1 deliverable %s is %s and names %s", (id, status, spec) => {
  const entry = entries.find((candidate) => candidate.id === id);
  expect(entry?.status, id).toBe(status);
  expect(entry?.notes, id).toContain(spec);
});
