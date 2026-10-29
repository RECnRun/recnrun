import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import {
  approximateBytes,
  IdentityListSchema,
  IdentitySchema,
  nextIdentityName,
} from "../src/index.ts";
import type { Identity } from "../src/index.ts";

const identity: Identity = {
  id: "id-1",
  label: "Alice",
  url: "https://app.example/",
  created: 1,
};

describe("IdentitySchema", () => {
  test("accepts an identity with or without its last capture", () => {
    expect(v.is(IdentitySchema, identity)).toBe(true);
    const captured = { ...identity, lastCapture: { id: "c-1", at: 5, bytes: 120 } };
    expect(v.is(IdentitySchema, captured)).toBe(true);
  });

  test("trims the label and refuses an empty or long one", () => {
    expect(v.parse(IdentitySchema, { ...identity, label: "  Bob " }).label).toBe("Bob");
    expect(v.is(IdentitySchema, { ...identity, label: "   " })).toBe(false);
    expect(v.is(IdentitySchema, { ...identity, label: "x".repeat(81) })).toBe(false);
  });

  test("refuses a target that is not a web page, and a negative or fractional size", () => {
    expect(v.is(IdentitySchema, { ...identity, url: "file:///etc/hosts" })).toBe(false);
    const sized = (bytes: number) => ({ ...identity, lastCapture: { id: "c", at: 1, bytes } });
    expect(v.is(IdentitySchema, sized(-1))).toBe(false);
    expect(v.is(IdentitySchema, sized(1.5))).toBe(false);
  });
});

describe("IdentityListSchema", () => {
  test("refuses two identities with one id", () => {
    expect(v.is(IdentityListSchema, [identity, { ...identity, label: "Other" }])).toBe(false);
    expect(v.is(IdentityListSchema, [identity, { ...identity, id: "id-2" }])).toBe(true);
  });
});

describe("approximateBytes", () => {
  test("counts strings as UTF-16, binary data by length, and nested values whole", () => {
    expect(approximateBytes("abc")).toBe(6);
    expect(approximateBytes(new Uint8Array(10))).toBe(10);
    expect(approximateBytes(new ArrayBuffer(4))).toBe(4);
    // Node's Blob, typed apart because the domain compiles without DOM types.
    const { Blob } = globalThis as unknown as { Blob: new (parts: string[]) => object };
    expect(approximateBytes(new Blob(["12345"]))).toBe(5);
    expect(approximateBytes([1, true, null, undefined])).toBe(12);
    expect(approximateBytes({ ab: "c", when: new Date(0) })).toBe(4 + 2 + 8 + 8);
    expect(approximateBytes(new Map([["k", 1n]]))).toBe(2 + 8);
    expect(approximateBytes(new Set(["xy"]))).toBe(4);
  });
});

describe("nextIdentityName", () => {
  test("names identities A to Z, then AA, AB, and on, taking the first free name", () => {
    expect(nextIdentityName([])).toBe("A");
    expect(nextIdentityName(["A", "B"])).toBe("C");
    expect(nextIdentityName(["B", "Admin"])).toBe("A");
    const alphabet = Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index));
    expect(nextIdentityName(alphabet)).toBe("AA");
    expect(nextIdentityName([...alphabet, "AA"])).toBe("AB");
    expect(
      nextIdentityName([
        ...alphabet,
        ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((each) => `A${each}`),
      ]),
    ).toBe("BA");
  });

  test("counts a taken name whatever its case or spaces", () => {
    expect(nextIdentityName([" a ", "b"])).toBe("C");
  });
});
