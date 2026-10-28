import { expect, test } from "vite-plus/test";
import { contentScriptExcludes, contentScriptMatches, peersEnabled } from "@/config/origins";

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

test("the content script skips the privacy policy on every origin it runs on", () => {
  expect(contentScriptExcludes("production")).toEqual(["https://recnrun.com/privacy/*"]);
  expect(contentScriptExcludes("test")).toEqual([
    "https://recnrun.com/privacy/*",
    "http://localhost/privacy/*",
    "http://127.0.0.1/privacy/*",
  ]);
});

test("only development and test builds carry the cross-profile POC", () => {
  expect(["development", "test"].map(peersEnabled)).toEqual([true, true]);
  expect(["production", "staging"].map(peersEnabled)).toEqual([false, false]);
});
