import { describe, expect, test } from "vite-plus/test";
import { aggregate, browserOf, provenance, summarize } from "./experiments/e1-aggregate.ts";
import type { E1Browser, ProbeResult } from "./experiments/e1-aggregate.ts";

const CHROME: E1Browser = { chrome: "Google Chrome 156.0.8078.79", method: "cdp-load-unpacked" };
const CHROMIUM: E1Browser = {
  chrome: "Google Chrome for Testing 156.0.8078.4",
  method: "chromium-load-extension",
  label: "diagnostic",
};

function sample(status: ProbeResult["status"], extra: Partial<ProbeResult> = {}): ProbeResult {
  return { id: "worker-close-target", status, ...extra };
}

describe("E1 aggregate", () => {
  test("keeps the detail of every sample, in order", () => {
    const { capability } = aggregate(
      "attach-dedicated-worker",
      [
        sample("allowed", { detail: { targetId: "A" } }),
        sample("allowed", { detail: { targetId: "B" } }),
        sample("allowed"),
      ],
      CHROME,
    );
    expect(capability).toEqual({
      status: "allowed",
      statuses: ["allowed", "allowed", "allowed"],
      method: "cdp-load-unpacked",
      details: [{ targetId: "A" }, { targetId: "B" }, null],
    });
  });

  test("a sample that differs makes the probe rejected with every error", () => {
    const { verdict, capability } = aggregate(
      "worker-close-target",
      [sample("allowed"), sample("rejected", { error: "worker still listed" }), sample("allowed")],
      CHROME,
    );
    expect(capability.status).toBe("rejected");
    expect(verdict).toMatchObject({
      experiment: "E1",
      hypothesis: "worker-close-target",
      verdict: "fail",
      error: "inconsistent across samples (allowed, rejected, allowed): worker still listed",
      chrome: CHROME.chrome,
      samples: 3,
    });
    expect(verdict.variants?.[1]).toEqual({
      name: "sample 2",
      verdict: "fail",
      error: "worker still listed",
    });
  });

  test("unavailable samples do not count as run", () => {
    const { verdict } = aggregate("tab-attach", [sample("unavailable")], CHROME);
    expect(verdict).toMatchObject({ verdict: "unavailable", samples: 0 });
  });
});

describe("E1 provenance (PLAN.md decisions 3 and 7)", () => {
  test("a diagnostic browser labels every verdict and capability entry", () => {
    const samples = new Map([
      ["tab-attach", [sample("allowed")]],
      ["infobar-hidden", [sample("rejected", { error: "tab height 1333 -> 1277" })]],
    ]);
    const { verdicts, capabilities } = summarize(samples, { "tab-attach": "attach" }, CHROMIUM);
    for (const verdict of verdicts) {
      expect(verdict).toMatchObject({ label: "diagnostic", method: "chromium-load-extension" });
    }
    expect(capabilities).toMatchObject({
      "tab-attach": { description: "attach", label: "diagnostic" },
      "infobar-hidden": { description: "", method: "chromium-load-extension" },
    });
    expect(provenance(CHROMIUM)).toEqual({
      method: "chromium-load-extension",
      label: "diagnostic",
    });
  });

  test("Google Chrome records its load method and no label", () => {
    const { verdict, capability } = aggregate("tab-attach", [sample("allowed")], CHROME);
    expect(verdict.method).toBe("cdp-load-unpacked");
    expect(verdict).not.toHaveProperty("label");
    expect(capability).not.toHaveProperty("label");
    expect(provenance(CHROME)).toEqual({ method: "cdp-load-unpacked" });
  });

  test("reads the browser from the loaded extension", () => {
    const chrome = { version: CHROMIUM.chrome } as Parameters<typeof browserOf>[0]["chrome"];
    expect(browserOf({ chrome, method: "chromium-load-extension", label: "diagnostic" })).toEqual(
      CHROMIUM,
    );
    expect(browserOf({ chrome, method: "cdp-load-unpacked" })).not.toHaveProperty("label");
  });
});
