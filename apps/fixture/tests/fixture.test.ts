import { expect, test } from "vite-plus/test";
import { createFixtureServer } from "@/index";

test("starts with no routes until F0.5 adds them", () => {
  expect(createFixtureServer()).toEqual({ routes: [] });
});
