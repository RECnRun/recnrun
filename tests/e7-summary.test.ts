import { describe, expect, test } from "vite-plus/test";
import { CHROME, START, THROWN, page, worker } from "./e7-builders.ts";
import {
  capabilitiesOf,
  summarize,
  summarizeIdentity,
  unavailable,
} from "./experiments/e7-summary.ts";

describe("E7 verdicts", () => {
  test("a realm passes only when every sample passed, with counts per kind and note", () => {
    const verdict = summarize("page", [page(), page({ start: START })], CHROME);
    expect(verdict).toMatchObject({
      experiment: "E7",
      hypothesis: "page",
      verdict: "fail",
      error: `1 of 2 samples failed: first effect without the marker: ${START} (1)`,
      chrome: CHROME.chrome,
      method: CHROME.method,
      samples: 2,
      counts: {
        samples: 2,
        passed: 1,
        failClosed: 0,
        firstEffectBeforeMarker: 1,
        beforeFirstScript: 1,
        unprefixedLocalStorage: 2,
      },
      variants: [{ name: "/storage.html", verdict: "fail", samples: 2 }],
    });
    expect(summarize("page", [page()], CHROME)).toMatchObject({ verdict: "pass", samples: 1 });
    expect(summarize("page", [], CHROME)).toMatchObject({
      verdict: "fail",
      error: "no sample ran",
    });
  });

  test("a worker realm that failed closed everywhere is a fail that counts every sample", () => {
    const refused = worker({ variant: "fail-closed/classic", effects: [] }, THROWN);
    const verdict = summarize("dedicated-worker", [refused, refused], CHROME);
    expect(verdict.verdict).toBe("fail");
    expect(verdict.counts).toMatchObject({ failClosed: 2, unpatched: 0, passed: 0 });
    expect(verdict.error).toBe(`2 of 2 samples failed: failed closed: ${THROWN} (2)`);
  });

  test("shared-worker identity holds only when two tabs of one session share one instance", () => {
    const verdict = summarizeIdentity(
      [
        { variant: "control-native", marker: "none", instances: 1, urls: [] },
        { variant: "blob", marker: "slot-4", instances: 2, urls: [] },
      ],
      CHROME,
    );
    expect(verdict).toMatchObject({
      hypothesis: "shared-worker-identity",
      verdict: "fail",
      error: "1 of 2 pairs ran separate instances: blob (1)",
      counts: { samples: 2, singleInstance: 1, separateInstances: 1 },
      variants: [
        { name: "control-native", verdict: "pass", samples: 1 },
        { name: "blob", verdict: "fail", samples: 1 },
      ],
    });
  });

  test("a realm the fixture lacks is unavailable with its reason", () => {
    expect(unavailable("sandboxed-frame", "no sandboxed frame", CHROME)).toEqual({
      experiment: "E7",
      hypothesis: "sandboxed-frame",
      verdict: "unavailable",
      error: "no sandboxed frame",
      chrome: CHROME.chrome,
      samples: 0,
      method: CHROME.method,
    });
  });

  test("capabilities say how often the script ran first, and which realms and wrappers held", () => {
    const refused = worker({ variant: "fail-closed/classic", effects: [] }, THROWN);
    const verdicts = [
      summarize("page", [page(), page({ start: START })], CHROME),
      summarize("dedicated-worker", [refused, worker()], CHROME),
      unavailable("about-blank-child", "no about:blank child", CHROME),
    ];
    expect(capabilitiesOf(verdicts, { world: "MAIN" })).toEqual({
      routeC: {
        registration: { world: "MAIN" },
        firstScript: { before: 1, samples: 2 },
        realms: { page: "fail", "dedicated-worker": "fail", "about-blank-child": "unavailable" },
        wrappers: {
          "dedicated-worker": { "fail-closed/classic": "fail", "blob/classic": "pass" },
          "shared-worker": {},
        },
      },
    });
  });
});
