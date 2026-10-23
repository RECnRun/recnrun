import { expect, test } from "vite-plus/test";
import { contentScriptMatches, disallowedAncestor, isAllowedEmbedder } from "@/config/origins";

test("an embedder must match a pattern's scheme and host, on any port", () => {
  expect(isAllowedEmbedder("https://recnrun.com", "production")).toBe(true);
  expect(isAllowedEmbedder("http://recnrun.com", "production")).toBe(false);
  expect(isAllowedEmbedder("http://localhost:5190", "production")).toBe(false);
  expect(isAllowedEmbedder("http://localhost:5190", "test")).toBe(true);
  expect(isAllowedEmbedder("http://forged.localhost:5191", "test")).toBe(false);
  expect(isAllowedEmbedder("not a url", "test")).toBe(false);
});

test("the dashboard names the first ancestor frame that is not an allowed site", () => {
  expect(disallowedAncestor([], "production")).toBeUndefined();
  expect(disallowedAncestor(["https://recnrun.com"], "production")).toBeUndefined();
  expect(disallowedAncestor(["https://recnrun.com", "https://evil.example"], "production")).toBe(
    "https://evil.example",
  );
});

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
