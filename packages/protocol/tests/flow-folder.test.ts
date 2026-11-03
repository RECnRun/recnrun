import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import { FlowManifestSchema, isId, parseStored, type FlowManifest } from "../src/index.ts";

const a = "a".repeat(64);
const b = "b".repeat(64);
const manifest: FlowManifest = {
  schemaVersion: 1,
  id: "form-submit",
  name: "Submit the form",
  revision: b,
  status: "draft",
  createdAt: "2026-11-02T10:00:00.000Z",
  updatedAt: "2026-11-02T10:05:00.000Z",
  revisions: [
    { revision: a, savedAt: "2026-11-02T10:00:00.000Z" },
    { revision: b, savedAt: "2026-11-02T10:05:00.000Z" },
  ],
};

test("a flow manifest names its current revision last in the history", () => {
  expect(v.parse(FlowManifestSchema, manifest)).toEqual(manifest);
  expect(parseStored("flow-manifest", { ...manifest, revision: a })).toEqual({
    ok: false,
    message: expect.stringContaining("last one in the history"),
  });
});

test.each([
  ["a revision that is not a sha256 digest", { revision: "abc" }],
  ["an unknown status", { status: "done" }],
  ["an empty history", { revisions: [] }],
  ["an unknown field", { extra: true }],
])("a flow manifest rejects %s", (_, change) => {
  expect(parseStored("flow-manifest", { ...manifest, ...change }).ok).toBe(false);
});

test("a dataset maps input names to values", () => {
  expect(parseStored("dataset", { schemaVersion: 1, inputs: { name: "Ana" } })).toEqual({
    ok: true,
    value: { schemaVersion: 1, inputs: { name: "Ana" } },
  });
  expect(parseStored("dataset", { schemaVersion: 1, inputs: { "not a name": 1 } }).ok).toBe(false);
});

test("a run catalog entry is running until it has a finish time and a status", () => {
  const entry = {
    id: "run-1",
    flowId: "form-submit",
    revision: a,
    status: "running",
    startedAt: "2026-11-02T10:00:00.000Z",
    finishedAt: null,
  };
  expect(parseStored("run-catalog-entry", entry).ok).toBe(true);
  expect(parseStored("run-catalog-entry", { ...entry, status: "paused" }).ok).toBe(false);
});

test.each([
  ["form-submit", true],
  ["CA-01", true],
  ["..", false],
  [".hidden", false],
  ["a/b", false],
  ["a\\b", false],
  ["", false],
  [42, false],
])("isId(%j) is %s, so an id is a safe folder name", (value, expected) => {
  expect(isId(value)).toBe(expected);
});
