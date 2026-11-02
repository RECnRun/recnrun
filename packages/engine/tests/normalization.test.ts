/// <reference types="vite-plus/client" />
import {
  checkCapturedEvent,
  checkNormalizationResult,
  type CapturedEvent,
  type NormalizationResult,
} from "@recnrun/protocol";
import { describe, expect, test } from "vite-plus/test";
import { normalize, type NormalizeOptions } from "../src/index.ts";

type Golden = {
  rule: string;
  options?: NormalizeOptions;
  input: CapturedEvent[];
  expected: NormalizationResult;
};

// Vite resolves the glob at build time, so a new golden file is picked up without editing this test.
const modules = import.meta.glob<Golden>("./normalization/*.json", {
  eager: true,
  import: "default",
});
const goldens: [string, Golden][] = Object.entries(modules)
  .map(([path, golden]): [string, Golden] => [path.replace("./normalization/", ""), golden])
  .toSorted(([a], [b]) => a.localeCompare(b));

describe("normalization goldens", () => {
  test("there is one golden pair per rule", () => {
    expect(goldens.length).toBeGreaterThanOrEqual(11);
  });

  test.each(goldens)("%s: inputs are schema-valid captured events", (_file, golden) => {
    for (const event of golden.input) {
      expect(checkCapturedEvent(event), event.id).toEqual({ ok: true });
    }
    expect(checkNormalizationResult(golden.expected)).toEqual({ ok: true });
  });

  test.each(goldens)("%s: normalize(input) equals expected", (_file, golden) => {
    expect(normalize(golden.input, golden.options)).toEqual(golden.expected);
  });
});

test("a mutated expectation fails the comparison", () => {
  const [, golden] = goldens.find(([file]) => file === "fill-grouping.json") ?? [];
  if (!golden) throw new Error("fill-grouping.json is missing");
  const actual = normalize(golden.input, golden.options);
  const mutations: ((result: NormalizationResult) => void)[] = [
    (result) => result.steps.pop(),
    (result) => result.steps[1]?.events.pop(),
    (result) => Object.assign(result.steps[1] ?? {}, { value: "Ad" }),
    (result) => result.excluded.pop(),
  ];
  for (const mutate of mutations) {
    const expected = JSON.parse(JSON.stringify(golden.expected)) as NormalizationResult;
    mutate(expected);
    expect(() => expect(actual).toEqual(expected)).toThrow();
  }
});

test("the input order does not change the result: events are ordered by timestamp", () => {
  const [, golden] = goldens.find(([file]) => file === "type-special-keys.json") ?? [];
  if (!golden) throw new Error("type-special-keys.json is missing");
  expect(normalize(golden.input.toReversed(), golden.options)).toEqual(golden.expected);
});
