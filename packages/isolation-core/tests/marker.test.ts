import { describe, expect, test } from "vite-plus/test";
import { logicalName, markUrl, parseMarker, physicalName } from "../src/index.ts";

const BASE = "http://app.localhost:4600/sw-main.js?variant=classic";

describe("markUrl", () => {
  test("appends the marker after the existing query, keeping its encoding", () => {
    expect(markUrl("http://api.localhost:4601/me?from=%2Fsw-main.js", "m1", BASE)).toBe(
      "http://api.localhost:4601/me?from=%2Fsw-main.js&__rec=m1",
    );
  });

  test("starts a query when there is none and keeps the fragment last", () => {
    expect(markUrl("http://api.localhost:4601/me#top", "m1", BASE)).toBe(
      "http://api.localhost:4601/me?__rec=m1#top",
    );
  });

  test("resolves a relative URL against the base", () => {
    expect(markUrl("/index.js", "m1", BASE)).toBe("http://app.localhost:4600/index.js?__rec=m1");
  });

  test("leaves non-http URLs, marked URLs, and unparsable URLs as they are", () => {
    expect(markUrl("data:text/plain,hi", "m1", BASE)).toBe("data:text/plain,hi");
    expect(markUrl("http://a.localhost/x?__rec=other", "m1", BASE)).toBe(
      "http://a.localhost/x?__rec=other",
    );
    expect(markUrl("/relative", "m1")).toBe("/relative");
  });
});

describe("storage names", () => {
  test("prefix the logical name with the reserved prefix and the marker", () => {
    expect(physicalName("m1", "fixture-sw")).toBe("__rec:m1:fixture-sw");
  });

  test("map a physical name back only for its own marker", () => {
    expect(logicalName("m1", "__rec:m1:fixture-sw")).toBe("fixture-sw");
    expect(logicalName("m1", "__rec:m2:fixture-sw")).toBeUndefined();
    expect(logicalName("m1", "fixture-sw")).toBeUndefined();
  });
});

describe("parseMarker", () => {
  test("accepts letters, digits, '_' and '-' only", () => {
    expect(parseMarker("e2-classic_01")).toBe("e2-classic_01");
    for (const bad of ["", "a b", "a:b", 'x");alert(1)//', "x".repeat(65), 7]) {
      expect(() => parseMarker(bad), String(bad)).toThrow();
    }
  });
});
