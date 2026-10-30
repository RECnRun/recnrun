import { expect, test } from "vite-plus/test";
import { contentScriptMatches, externalMatches, recorderMatches } from "@/config/origins";

const PRODUCTION = ["https://recnrun.com/*"];
const LOCAL = ["http://localhost/*", "http://127.0.0.1/*"];

test("production builds match only the RECnRun domains", () => {
  expect(contentScriptMatches("production")).toEqual(PRODUCTION);
  expect(externalMatches("production")).toEqual(PRODUCTION);
});

test("unknown modes fall back to the production origins", () => {
  expect(contentScriptMatches("staging")).toEqual(PRODUCTION);
  expect(externalMatches("staging")).toEqual(PRODUCTION);
});

test("development and test builds also match local servers on any port", () => {
  for (const mode of ["development", "test"]) {
    expect(contentScriptMatches(mode)).toEqual([...PRODUCTION, ...LOCAL]);
    expect(externalMatches(mode)).toEqual([...PRODUCTION, ...LOCAL]);
  }
});

test("only the test build pre-grants the recorder access to local servers", () => {
  expect(recorderMatches("test")).toEqual(LOCAL);
  expect(recorderMatches("development")).toEqual([]);
  expect(recorderMatches("production")).toEqual([]);
});
