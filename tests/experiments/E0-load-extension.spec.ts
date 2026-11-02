import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";
import { expect, resolveChromePath, test } from "../browser/fixtures/chrome.ts";
import {
  forceInstallByPolicy,
  loadInChromium,
  loadUnpackedOverCdp,
  UnavailableError,
} from "../browser/fixtures/extension-loaders.ts";
import type { LoadedExtension, LoadMethod } from "../browser/fixtures/extension-loaders.ts";
import { ISOLATOR_PATH } from "../browser/fixtures/extension.ts";
import { appendVerdict, mergeCapabilities, readVerdicts } from "./verdicts.ts";
import type { Verdict } from "./verdicts.ts";

// Hypotheses of PLAN.md P0.3; docs/poc/namespace-sessions/experiments/E0.md reports them.
const EXPERIMENT = "E0";
const METHODS: Record<string, LoadMethod> = {
  a: "cdp-load-unpacked",
  b: "managed-policy",
  c: "chromium-load-extension",
};
// The isolator's chrome.storage.session marker (apps/isolator/src/background/start.ts).
const MARKER = 'chrome.storage.session.get("isolatorLoaded").then((items) => items.isolatorLoaded)';

type Variant = NonNullable<Verdict["variants"]>[number];

async function versionOf(executable: string): Promise<string> {
  const run = promisify(execFile);
  return (await run(executable, ["--version"])).stdout.trim();
}

/** Loads, checks that the background ran, and closes; never throws. */
async function attempt(name: string, load: () => Promise<LoadedExtension>): Promise<Variant> {
  try {
    const extension = await load();
    try {
      await expect
        .poll(() => extension.evaluateInBackground(MARKER), { timeout: 10_000 })
        .toMatchObject({ loaded: true, id: extension.extensionId });
      return { name, verdict: "pass" };
    } finally {
      await extension.close();
    }
  } catch (error) {
    const verdict = error instanceof UnavailableError ? "unavailable" : "fail";
    return { name, verdict, error: error instanceof Error ? error.message : String(error) };
  }
}

async function record(
  hypothesis: string,
  chrome: string,
  variants: Variant[],
  label?: Verdict["label"],
): Promise<Verdict> {
  const passed = variants.some((variant) => variant.verdict === "pass");
  const ran = variants.filter((variant) => variant.verdict !== "unavailable");
  const verdict: Verdict = {
    experiment: EXPERIMENT,
    hypothesis,
    verdict: passed ? "pass" : ran.length > 0 ? "fail" : "unavailable",
    chrome,
    samples: ran.length,
    ...(label ? { label } : {}),
    variants,
  };
  if (!passed)
    verdict.error = variants.map((variant) => `${variant.name}: ${variant.error}`).join("; ");
  await appendVerdict(verdict);
  console.log(JSON.stringify(verdict));
  return verdict;
}

test.describe("E0: load the unpacked isolator into Google Chrome Stable", () => {
  test.describe.configure({ timeout: 120_000 });

  test("(a) Extensions.loadUnpacked with --enable-unsafe-extension-debugging", async () => {
    const variants = [
      await attempt("port", () => loadUnpackedOverCdp(ISOLATOR_PATH)),
      await attempt("pipe+port", () => loadUnpackedOverCdp(ISOLATOR_PATH, { transport: "pipe" })),
    ];
    await record("a", await versionOf(resolveChromePath()), variants);
  });

  test("(a) control: Extensions.loadUnpacked without the unsafe debugging flag", async () => {
    const variants = [
      await attempt("port, no flag", () =>
        loadUnpackedOverCdp(ISOLATOR_PATH, { unsafeDebugging: false }),
      ),
    ];
    await record("a-control", await versionOf(resolveChromePath()), variants, "control");
  });

  test("(b) managed policy force-installs a CRX3 from a loopback update server", async () => {
    const variants = [
      await attempt("DeveloperToolsAvailability default", () =>
        forceInstallByPolicy(ISOLATOR_PATH, false),
      ),
      await attempt("DeveloperToolsAvailability 1", () => forceInstallByPolicy(ISOLATOR_PATH)),
    ];
    await record("b", await versionOf(resolveChromePath()), variants);
  });

  test("(c) fallback: Playwright Chromium with --load-extension", async () => {
    const variants = [await attempt("chromium", () => loadInChromium(ISOLATOR_PATH))];
    await record("c", await versionOf(chromium.executablePath()), variants, "diagnostic");
  });

  test("every hypothesis has a verdict and capabilities.json names the method", async () => {
    const verdicts = (await readVerdicts()).filter(
      (entry) => entry.experiment === EXPERIMENT && entry.label !== "control",
    );
    const latest = new Map(verdicts.map((entry) => [entry.hypothesis, entry]));
    expect([...latest.keys()].sort(), "every hypothesis ran").toEqual(["a", "b", "c"]);
    const sampled = [...latest.values()].filter((entry) => entry.samples > 0);
    expect(sampled.length, "at least one method produced a sampled verdict").toBeGreaterThan(0);
    const first = ["a", "b", "c"].find((hypothesis) => latest.get(hypothesis)?.verdict === "pass");
    expect(first, "a method loaded the extension").toBeDefined();
    const method = METHODS[first ?? ""];
    const capabilities = await mergeCapabilities({
      chrome: { version: latest.get("a")?.chrome },
      extensionLoad: { method, ...(first === "c" ? { label: "diagnostic" } : {}) },
    });
    expect(capabilities).toMatchObject({ extensionLoad: { method } });
  });
});
