import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import { scanHarness, scanSource } from "./harness-scan.ts";
import type { Site } from "./harness-scan.ts";

/**
 * POC PLAN.md decisions 5 and 7: the harness observes and never provides capability. Every CDP
 * command a file under tests/browser, tests/experiments, or tests/host sends is listed here with its reason.
 */
const ALLOWED_COMMANDS: Record<string, string> = {
  "Browser.getVersion": "reads the product string",
  "Extensions.loadUnpacked": "installs the test build, the diagnostic install method",
  "Target.getTargets": "finds the extension's service worker",
  "Target.attachToTarget": "attaches to that worker or to a tab the harness opened (cdp-client.ts)",
  "Target.detachFromTarget": "detaches that session",
  "Target.createTarget":
    "opens the extension's diagnostics page or chrome://extensions (cdp-client.ts)",
  "Target.closeTarget": "closes a tab the harness opened",
  "Runtime.evaluate": "pings the extension's own worker and reads its pages (cdp-client.ts)",
  "Input.dispatchMouseEvent":
    "E1's recorded fallback click on the file-access toggle where no xdotool exists (macOS host)",
  "Browser.setDownloadBehavior":
    "E2, E4, and silent-start reset to Chrome's default the download override Playwright's connectOverCDP installs",
};

/** Commands that pause, instrument, block, or rewrite. */
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

/** Runtime.evaluate and computed methods only where the client reaches the extension's worker. */
const CLIENT_FILE = "tests/browser/fixtures/cdp-client.ts";

const ALLOWED_FLAGS: Record<string, string> = {
  "--user-data-dir": "throwaway root",
  "--remote-debugging-port": "CDP for Playwright in diagnostic cells",
  "--remote-debugging-pipe": "pipe-only CDP commands",
  "--no-first-run": "no first-run dialogs",
  "--no-sandbox": "Chrome runs as root in Docker",
  "--silent-debugger-extension-api": "hides the debugging infobar",
  "--enable-unsafe-extension-debugging": "Extensions.loadUnpacked",
  "--version": "a version query, not a browser launch",
  "--no-default-browser-check": "no default-browser prompt on the host",
  "--use-mock-keychain": "the host never reads the owner's Chrome Safe Storage key",
  "--window-position": "keeps host windows off the owner's screen",
  "--window-size": "keeps host windows small",
};

function commandViolation(site: Site): string | undefined {
  if (FORBIDDEN_COMMANDS.some((pattern) => pattern.test(site.name))) {
    return `${site.name} is forbidden by decision 5`;
  }
  if (!(site.name in ALLOWED_COMMANDS)) return `${site.name} is not in the observer allowlist`;
  if (site.name === "Runtime.evaluate" && site.file !== CLIENT_FILE) {
    return `Runtime.evaluate is allowed only in ${CLIENT_FILE}`;
  }
  return undefined;
}

function flagViolation(site: Site): string | undefined {
  // Branded Chrome 137 and later ignore it (decision 5); a harness that passes it tests nothing.
  if (site.name === "--load-extension") return "--load-extension is forbidden on Google Chrome";
  if (site.name.startsWith("--disable-")) return `${site.name} is forbidden by decision 5`;
  if (!(site.name in ALLOWED_FLAGS)) return `${site.name} is not an allowed launch flag`;
  return undefined;
}

function violation(site: Site): string | undefined {
  switch (site.kind) {
    case "cdp":
      return commandViolation(site);
    case "dynamic-cdp":
      return site.file === CLIENT_FILE
        ? undefined
        : "a CDP method must be a string literal at the send call site";
    case "flag":
      return flagViolation(site);
    case "playwright":
      return `Playwright's ${site.name}() rewrites or injects into the page`;
  }
}

function violations(sites: Site[]): string[] {
  return sites.flatMap((site) => {
    const reason = violation(site);
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
    expect(violations(sites)).toEqual([
      "tests/browser/scratch.spec.ts:1 Fetch.enable: Fetch.enable is forbidden by decision 5",
      "tests/browser/scratch.spec.ts:2 Target.setAutoAttach: Target.setAutoAttach is forbidden by decision 5",
      "tests/browser/scratch.spec.ts:3 Emulation.setTimezoneOverride: Emulation.setTimezoneOverride is forbidden by decision 5",
      "tests/browser/scratch.spec.ts:6 <computed>: a CDP method must be a string literal at the send call site",
    ]);
  });

  test("rejects raw Runtime.evaluate outside the CDP client and Playwright's page injection", () => {
    const code = 'await cdp.send("Runtime.evaluate", {});\nawait page.addInitScript("1");';
    expect(violations(scanSource("tests/browser/x.ts", code))).toEqual([
      `tests/browser/x.ts:1 Runtime.evaluate: Runtime.evaluate is allowed only in ${CLIENT_FILE}`,
      "tests/browser/x.ts:2 addInitScript: Playwright's addInitScript() rewrites or injects into the page",
    ]);
  });

  test("rejects --load-extension, --disable-*, and unknown flags, wherever they are written", () => {
    const code =
      'launchChrome({ args: ["--disable-back-forward-cache", `--lang=${x}`, `--load-extension=${p}`] });';
    expect(violations(scanSource("tests/experiments/x.spec.ts", code))).toEqual([
      "tests/experiments/x.spec.ts:1 --disable-back-forward-cache: --disable-back-forward-cache is forbidden by decision 5",
      "tests/experiments/x.spec.ts:1 --lang: --lang is not an allowed launch flag",
      "tests/experiments/x.spec.ts:1 --load-extension: --load-extension is forbidden on Google Chrome",
    ]);
  });
});
