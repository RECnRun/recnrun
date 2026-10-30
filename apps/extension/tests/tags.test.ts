import { expect, test } from "vite-plus/test";
import { parseTags } from "@/popup/tags";

test("splits tags on commas and whitespace, dropping blanks and duplicates", () => {
  expect(parseTags(" env:local, feature:login env:local\n")).toEqual([
    "env:local",
    "feature:login",
  ]);
  expect(parseTags("")).toEqual([]);
});
