import { describe, expect, test } from "vite-plus/test";
import { chromeFlags } from "./browser/fixtures/chrome.ts";

const SILENT = "--silent-debugger-extension-api";

describe("chromeFlags", () => {
  test("hides the debugger infobar by default", () => {
    expect(chromeFlags("/profile")).toContain(SILENT);
  });

  test("leaves the infobar flag out on request and keeps the rest", () => {
    const shown = chromeFlags("/profile", ["--extra"], false);
    expect(shown).not.toContain(SILENT);
    expect(shown).toEqual(chromeFlags("/profile", ["--extra"]).filter((flag) => flag !== SILENT));
  });
});
