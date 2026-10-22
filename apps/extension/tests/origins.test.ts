import { expect, test } from "vite-plus/test";
import { contentScriptMatches } from "@/config/origins";

const PRODUCTION = ["https://recnrun.com/*"];

test("production builds match only the RECnRun domains", () => {
  expect(contentScriptMatches("production")).toEqual(PRODUCTION);
});

test("unknown modes fall back to the production origins", () => {
  expect(contentScriptMatches("staging")).toEqual(PRODUCTION);
});

test("development and test builds also match local servers on any port", () => {
  for (const mode of ["development", "test"]) {
    expect(contentScriptMatches(mode)).toEqual([
      ...PRODUCTION,
      "http://localhost/*",
      "http://127.0.0.1/*",
    ]);
  }
});
