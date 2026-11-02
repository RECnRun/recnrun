import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import { scanHarness, scanSource } from "./harness-scan.ts";
import type { Site } from "./harness-scan.ts";

/**
 * POC PLAN.md decision 5: the harness observes and never provides capability. Every CDP command a
 * file under tests/browser or tests/experiments sends must be listed here with its reason.
 */
const ALLOWED_COMMANDS: Record<string, string> = {
  "Browser.getVersion": "reads the product string",
  // The one state-changing command: headed Chrome otherwise blocks pushManager.subscribe() on a prompt nobody answers.
  "Browser.setPermission": "denies the notification permission (fixture.spec.ts)",
  "Target.getTargets": "lists targets",
  "Target.attachToTarget": "attaches to the extension's service worker (cdp-client.ts)",
  "Target.detachFromTarget": "detaches that session",
  "Target.setDiscoverTargets": "the observer's target events",
  "Extensions.loadUnpacked": "loads the isolator, E0 method (a)",
  "Runtime.evaluate": "only in the extension loaders, against the extension's own worker",
  "Network.enable": "the observer's network events",
  "Network.getCookies": "storage inventory",
  "Page.enable": "the observer's navigation events",
  "Runtime.enable": "the observer's console events",
  "DOMStorage.enable": "storage inventory",
  "DOMStorage.getDOMStorageItems": "storage inventory (keys only are kept)",
  "IndexedDB.requestDatabaseNames": "storage inventory",
  "CacheStorage.requestCacheNames": "storage inventory",
  "Storage.getUsageAndQuota": "storage inventory",
  "Storage.getCookies": "storage inventory and the redaction check",
};

/** Commands that pause, instrument, block, or rewrite (decision 5 and P0.7). */
const FORBIDDEN_COMMANDS: RegExp[] = [
  /^ServiceWorker\./,
  /^Fetch\./,
  /^Debugger\./,
  /^Emulation\./,
  /^Storage\.clear/,
  /^Target\.setAutoAttach$/,
  /^Page\.addScriptToEvaluateOnNewDocument$/,
  /^Page\.setBypassCSP$/,
  /^Network\.(setCookies?|deleteCookies|clearBrowserCookies)$/,
  /^Storage\.setCookies$/,
  /^Network\.setExtraHTTPHeaders$/,
  /^Network\.setUserAgentOverride$/,
];

/** Runtime.evaluate reaches only the extension's service worker from these files. */
const RUNTIME_EVALUATE_FILES = [
  "tests/browser/fixtures/cdp-client.ts",
  "tests/browser/fixtures/extension.ts",
  "tests/browser/fixtures/extension-loaders.ts",
];

/** The CDP client implementation forwards whatever method its callers name. */
const DYNAMIC_SEND_FILES = ["tests/browser/fixtures/cdp-client.ts"];

const ALLOWED_FLAGS: Record<string, string> = {
  "--user-data-dir": "throwaway profile",
  "--remote-debugging-port": "CDP for Playwright and the observer",
  "--remote-debugging-pipe": "pipe-only CDP commands (E0)",
  "--no-first-run": "no first-run dialogs",
  "--no-sandbox": "Chrome runs as root in Docker",
  "--silent-debugger-extension-api": "hides the debugging infobar",
  "--enable-unsafe-extension-debugging": "Extensions.loadUnpacked (E0)",
  "--version": "a version query, not a browser launch",
};

const LOADERS_FILE = "tests/browser/fixtures/extension-loaders.ts";
const DIAGNOSTIC_LOADER = "loadInChromium";

function commandViolation(site: Site): string | undefined {
  const forbidden = FORBIDDEN_COMMANDS.some((pattern) => pattern.test(site.name));
  if (forbidden) return `${site.name} is forbidden by decision 5`;
  if (!(site.name in ALLOWED_COMMANDS)) return `${site.name} is not in the observer allowlist`;
  if (site.name === "Runtime.evaluate" && !RUNTIME_EVALUATE_FILES.includes(site.file)) {
    return "Runtime.evaluate is allowed only in the extension loaders";
  }
  return undefined;
}

/** `--load-extension` only in the diagnostic Chromium loader, which always names its executable. */
function loadExtensionViolation(site: Site, sites: Site[]): string | undefined {
  if (site.file !== LOADERS_FILE || site.within !== DIAGNOSTIC_LOADER) {
    return `--load-extension is allowed only in ${DIAGNOSTIC_LOADER} (${LOADERS_FILE})`;
  }
  const launches = sites.filter(
    (other) => other.kind === "launch" && other.file === site.file && other.within === site.within,
  );
  if (launches.length === 0 || launches.some((launch) => launch.name !== "true")) {
    return `${DIAGNOSTIC_LOADER} must pass Playwright's Chromium as executable to launchChrome`;
  }
  return undefined;
}

function flagViolation(site: Site, sites: Site[]): string | undefined {
  if (site.name === "--load-extension") return loadExtensionViolation(site, sites);
  if (site.name.startsWith("--disable-")) return `${site.name} is forbidden by decision 5`;
  if (!(site.name in ALLOWED_FLAGS)) return `${site.name} is not an allowed launch flag`;
  return undefined;
}

function violation(site: Site, sites: Site[]): string | undefined {
  switch (site.kind) {
    case "cdp":
      return commandViolation(site);
    case "dynamic-cdp":
      return DYNAMIC_SEND_FILES.includes(site.file)
        ? undefined
        : "a CDP method must be a string literal at the send call site";
    case "flag":
      return flagViolation(site, sites);
    case "playwright":
      return `Playwright's ${site.name}() sends capability-providing CDP commands`;
    case "launch":
      return undefined;
  }
}

function violations(sites: Site[]): string[] {
  return sites.flatMap((site) => {
    const reason = violation(site, sites);
    return reason ? [`${site.file}:${site.line} ${site.name}: ${reason}`] : [];
  });
}

const ROOT = fileURLToPath(new URL("../", import.meta.url));

describe("observer allowlist", () => {
  test("the harness sends only allowed CDP commands and launches Chrome with allowed flags", async () => {
    const sites = await scanHarness(ROOT);
    expect(sites.filter((site) => site.kind === "cdp").length).toBeGreaterThan(0);
    expect(violations(sites)).toEqual([]);
  });

  test("no allowed command is also forbidden", () => {
    const both = Object.keys(ALLOWED_COMMANDS).filter((name) =>
      FORBIDDEN_COMMANDS.some((pattern) => pattern.test(name)),
    );
    expect(both).toEqual([]);
  });

  test("finds CDP commands at send call sites only, not names used as data", () => {
    const code = [
      'await cdp.send("Fetch.enable", {});',
      'await session.send<{ id: string }>("Target.setAutoAttach");',
      'await client["send"](`Emulation.setTimezoneOverride`);',
      'await probe("Debugger.pause");',
      'const name = "ServiceWorker.enable"; // cdp.send("Network.setCookie")',
      "await cdp.send(name);",
      'socket.send("hello");',
    ].join("\n");
    const sites = scanSource("tests/browser/scratch.spec.ts", code);
    expect(sites.map((site) => `${site.kind} ${site.name}`)).toEqual([
      "cdp Fetch.enable",
      "cdp Target.setAutoAttach",
      "cdp Emulation.setTimezoneOverride",
      "dynamic-cdp <computed>",
    ]);
    expect(violations(sites)).toEqual([
      "tests/browser/scratch.spec.ts:1 Fetch.enable: Fetch.enable is forbidden by decision 5",
      "tests/browser/scratch.spec.ts:2 Target.setAutoAttach: Target.setAutoAttach is forbidden by decision 5",
      "tests/browser/scratch.spec.ts:3 Emulation.setTimezoneOverride: Emulation.setTimezoneOverride is forbidden by decision 5",
      "tests/browser/scratch.spec.ts:6 <computed>: a CDP method must be a string literal at the send call site",
    ]);
  });

  test("rejects raw Runtime.evaluate outside the extension loaders and Playwright's page scripting", () => {
    const code = 'await cdp.send("Runtime.evaluate", {});\nawait page.evaluate(() => 1);';
    expect(violations(scanSource("tests/browser/observer/x.ts", code))).toEqual([
      "tests/browser/observer/x.ts:1 Runtime.evaluate: Runtime.evaluate is allowed only in the extension loaders",
      "tests/browser/observer/x.ts:2 evaluate: Playwright's evaluate() sends capability-providing CDP commands",
    ]);
  });

  test("rejects --disable-* and unknown flags, wherever they are written", () => {
    const code = 'test.use({ chromeArgs: ["--disable-back-forward-cache", `--lang=${x}`] });';
    expect(violations(scanSource("tests/experiments/x.spec.ts", code))).toEqual([
      "tests/experiments/x.spec.ts:1 --disable-back-forward-cache: --disable-back-forward-cache is forbidden by decision 5",
      "tests/experiments/x.spec.ts:1 --lang: --lang is not an allowed launch flag",
    ]);
  });

  test("allows --load-extension only in the Chromium loader that names its executable", () => {
    const loader = (body: string) =>
      `export async function ${DIAGNOSTIC_LOADER}(path: string) { ${body} }`;
    const good = loader("await launchChrome({ executable, args: [`--load-extension=${path}`] });");
    const branded = loader("await launchChrome({ args: [`--load-extension=${path}`] });");
    const elsewhere = 'const args = ["--load-extension=/x"];';
    expect(violations(scanSource(LOADERS_FILE, good))).toEqual([]);
    expect(violations(scanSource(LOADERS_FILE, branded))).toEqual([
      `${LOADERS_FILE}:1 --load-extension: ${DIAGNOSTIC_LOADER} must pass Playwright's Chromium as executable to launchChrome`,
    ]);
    expect(violations(scanSource("tests/browser/fixtures/chrome.ts", elsewhere))).toEqual([
      `tests/browser/fixtures/chrome.ts:1 --load-extension: --load-extension is allowed only in ${DIAGNOSTIC_LOADER} (${LOADERS_FILE})`,
    ]);
  });
});
