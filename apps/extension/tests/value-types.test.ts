import { expect, test } from "vite-plus/test";
import { collectValueTypes } from "@/background/workspace/value-types";

const typesOf = (...values: unknown[]) => {
  const found = new Set<string>();
  collectValueTypes(values, found as Set<never>);
  return [...found].toSorted();
};

test("names each structured-clone type, the narrower one first", () => {
  expect(typesOf(1, "a", null, undefined, true)).toEqual(["primitive"]);
  expect(typesOf(new Date(0))).toEqual(["Date"]);
  expect(typesOf(/x/g)).toEqual(["RegExp"]);
  expect(typesOf(new ArrayBuffer(2))).toEqual(["ArrayBuffer"]);
  expect(typesOf(new DataView(new ArrayBuffer(2)))).toEqual(["DataView"]);
  expect(typesOf(new Uint8Array(2), new Float64Array(1))).toEqual(["TypedArray"]);
  expect(typesOf(new File(["x"], "a.txt"))).toEqual(["File"]);
  expect(typesOf(new Blob(["x"]))).toEqual(["Blob"]);
});

test("looks inside objects, arrays, maps, and sets, at any depth", () => {
  const nested = {
    list: [new Map([[new Date(0), new Set([new Blob(["x"])])]])],
    deep: { deeper: { deepest: new Uint8Array(1) } },
  };
  expect(typesOf(nested)).toEqual(["Array", "Blob", "Date", "Map", "Object", "Set", "TypedArray"]);
});

test("visits a value that refers to itself once", () => {
  const loop: { self?: unknown; n: number } = { n: 1 };
  loop.self = loop;
  expect(typesOf(loop)).toEqual(["Object", "primitive"]);
});
