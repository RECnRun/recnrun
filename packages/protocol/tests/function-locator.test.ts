import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import {
  ElementReferenceSchema,
  FunctionLocatorRequestSchema,
  FunctionLocatorResultSchema,
  LOCATOR_STATUSES,
} from "../src/index.ts";

const element = {
  targetId: "T1",
  frameId: "F1",
  loaderId: "L1",
  objectId: "-1.2.3",
  backendNodeId: 12,
};

const matched = {
  status: "matched",
  cardinality: "one",
  count: 1,
  elements: [element],
  durationMs: 3.5,
  objectGroup: "recnrun-locator-1",
};

test("the statuses are the source plan's five", () => {
  expect(LOCATOR_STATUSES).toEqual(["matched", "not-found", "ambiguous", "unsupported", "error"]);
});

test("an element reference is qualified by target, frame, and document", () => {
  expect(v.parse(ElementReferenceSchema, element)).toEqual(element);
  expect(v.is(ElementReferenceSchema, { ...element, backendNodeId: 0 })).toBe(false);
  expect(v.is(ElementReferenceSchema, { ...element, frameId: "" })).toBe(false);
  expect(v.is(ElementReferenceSchema, { ...element, extra: 1 })).toBe(false);
  const { loaderId: _loaderId, ...unqualified } = element;
  expect(v.is(ElementReferenceSchema, unqualified)).toBe(false);
});

test("a request needs source, cardinality, and timeout, and nth needs an index", () => {
  const request = { source: "() => null", cardinality: "one", timeoutMs: 1000 };
  expect(v.is(FunctionLocatorRequestSchema, request)).toBe(true);
  const scoped = { ...request, frameId: "F1", args: { id: 1 } };
  expect(v.is(FunctionLocatorRequestSchema, scoped)).toBe(true);
  expect(v.is(FunctionLocatorRequestSchema, { ...request, cardinality: "nth" })).toBe(false);
  const nth = { ...request, cardinality: "nth", index: 2 };
  expect(v.is(FunctionLocatorRequestSchema, nth)).toBe(true);
  expect(v.is(FunctionLocatorRequestSchema, { ...request, source: "" })).toBe(false);
  expect(v.is(FunctionLocatorRequestSchema, { ...request, timeoutMs: 0 })).toBe(false);
});

test("a result carries its status, count, references, and duration", () => {
  expect(v.parse(FunctionLocatorResultSchema, matched)).toEqual(matched);
  const failed = {
    ...matched,
    status: "error",
    count: 0,
    elements: [],
    error: { message: "Error: boom" },
  };
  expect(v.is(FunctionLocatorResultSchema, failed)).toBe(true);
  expect(v.is(FunctionLocatorResultSchema, { ...matched, status: "found" })).toBe(false);
  expect(v.is(FunctionLocatorResultSchema, { ...matched, durationMs: -1 })).toBe(false);
});

test("a deadline records whether the call was terminated and the tab still answers", () => {
  const cut = {
    ...matched,
    status: "error",
    count: 0,
    elements: [],
    error: { message: "The locator function did not finish within 500 ms." },
    deadline: { timeoutMs: 500, blocked: true, terminated: true, tabResponsive: true },
  };
  expect(v.is(FunctionLocatorResultSchema, cut)).toBe(true);
  const vague = { ...cut, deadline: { ...cut.deadline, terminated: "yes" } };
  expect(v.is(FunctionLocatorResultSchema, vague)).toBe(false);
});

test("only a matched result carries element references", () => {
  const ambiguous = { ...matched, status: "ambiguous", count: 2 };
  expect(v.is(FunctionLocatorResultSchema, ambiguous)).toBe(false);
  expect(v.is(FunctionLocatorResultSchema, { ...ambiguous, elements: [] })).toBe(true);
});
