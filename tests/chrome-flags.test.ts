import { describe, expect, test } from "vite-plus/test";
import { chromeFlags } from "./browser/fixtures/chrome.ts";

const SILENT = "--silent-debugger-extension-api";
const PORT = "--remote-debugging-port=0";

describe("chromeFlags", () => {
  test("hides the debugger infobar by default", () => {
    expect(chromeFlags("/profile")).toContain(SILENT);
  });

  test("leaves the infobar flag out on request and keeps the rest", () => {
    const shown = chromeFlags("/profile", ["--extra"], false);
    expect(shown).not.toContain(SILENT);
    expect(shown).toEqual(chromeFlags("/profile", ["--extra"]).filter((flag) => flag !== SILENT));
  });

  test("opens the debugging port by default", () => {
    expect(chromeFlags("/profile")).toContain(PORT);
  });

  test("leaves every remote debugging flag out without CDP and keeps the rest", () => {
    const strict = chromeFlags("/profile", ["--extra"], false, false);
    expect(strict.filter((flag) => flag.startsWith("--remote-debugging"))).toEqual([]);
    const withPort = chromeFlags("/profile", ["--extra"], false);
    expect(strict).toEqual(withPort.filter((flag) => flag !== PORT));
  });
});
