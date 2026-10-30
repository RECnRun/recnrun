import { expect, test } from "vite-plus/test";
import { originOf, originPattern, urlMatches } from "@/background/origin-patterns";

test("turns a page URL into a host permission pattern for every port", () => {
  expect(originPattern("http://localhost:4300/login?x=1")).toBe("http://localhost/*");
  expect(originPattern("https://app.example.com/path")).toBe("https://app.example.com/*");
  expect(originPattern("http://127.0.0.1:3000/")).toBe("http://127.0.0.1/*");
});

test("has no pattern for pages the recorder cannot run on", () => {
  for (const url of [
    "chrome://extensions",
    "about:blank",
    "file:///tmp/a.html",
    "not a url",
    undefined,
  ]) {
    expect(originPattern(url)).toBeUndefined();
  }
});

test("matches URLs against the manifest patterns", () => {
  const patterns = ["https://recnrun.com/*", "http://localhost/*"];
  expect(urlMatches("https://recnrun.com/#/workflows/1", patterns)).toBe(true);
  expect(urlMatches("http://localhost:5173/", patterns)).toBe(true);
  expect(urlMatches("http://recnrun.com/", patterns)).toBe(false);
  expect(urlMatches("https://evil.recnrun.com/", patterns)).toBe(false);
  expect(urlMatches("https://evil.local/", patterns)).toBe(false);
  expect(urlMatches("garbage", patterns)).toBe(false);
  expect(urlMatches(undefined, patterns)).toBe(false);
});

test("reads the origin of a URL", () => {
  expect(originOf("http://localhost:5173/#/")).toBe("http://localhost:5173");
  expect(originOf("garbage")).toBeUndefined();
});
