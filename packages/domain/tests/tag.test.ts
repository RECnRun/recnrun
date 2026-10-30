import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import { TagSchema, TagsSchema } from "../src/index.ts";

describe("TagSchema", () => {
  test("accepts a tag and colon-separated subtags, keeping case", () => {
    for (const tag of ["login", "env:local", "env:ACC", "a:b:c:d", "rerun-of:wf_1"]) {
      expect(v.parse(TagSchema, tag)).toBe(tag);
    }
  });

  test("rejects empty segments, spaces, and other separators", () => {
    for (const tag of ["", ":", "env:", ":local", "a::b", "env local", "env/local", "a:b "]) {
      expect(v.is(TagSchema, tag)).toBe(false);
    }
  });
});

describe("TagsSchema", () => {
  test("rejects duplicate tags", () => {
    expect(v.is(TagsSchema, ["env:local", "env:local"])).toBe(false);
    expect(v.is(TagsSchema, ["env:local", "env:ACC"])).toBe(true);
  });
});
