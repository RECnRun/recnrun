import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { TestInfo } from "@playwright/test";
import { expect, launchChrome, test } from "../browser/fixtures/chrome.ts";
import { labRig } from "../browser/fixtures/launcher-rig.ts";
import { windowOwners } from "../browser/fixtures/x-display.ts";
import { ackProblems, quit, runOpen } from "../experiments/fixtures/launcher-open.ts";
import type { Opened } from "../experiments/fixtures/launcher-open.ts";

/*
 * POC PLAN.md P7.1 (R2, R9, R10): the launcher's open.sh starts Google Chrome Stable with Chrome's
 * own --headless, and the harness reads only files, /proc, and the X server, never a CDP client.
 */

const run = promisify(execFile);
const MODE = "headless";

/** The NUL-separated command line of a process, as `ps` shows it. */
const commandLine = async (pid: number) =>
  (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);

/** A fresh poc-d0 root opened by `open.sh ... headless`; Chrome is stopped and the root removed after `body`. */
async function withOpened(
  testInfo: TestInfo,
  env: NodeJS.ProcessEnv,
  body: (opened: Opened, root: string) => Promise<void>,
) {
  const rig = await labRig(testInfo);
  try {
    const opened = await runOpen({ scene: rig.scene, env: { ...rig.env, ...env } }, MODE);
    expect(opened.code, opened.stderr).toBe(0);
    expect(opened.pid).toBeGreaterThan(0);
    expect(await ackProblems(rig.scene, opened)).toEqual([]);
    await body(opened, rig.scene.root);
    await quit(rig, [opened.pid]);
    expect(await rig.survivors(), "Chrome left running on the root").toEqual([]);
  } catch (error) {
    await rig.keep?.().catch(() => undefined);
    throw error;
  } finally {
    await rig.dispose();
  }
}

test.describe("open.sh ... headless starts Google Chrome Stable in its native headless mode", () => {
  test("strict: no display, no debugging flag, the real Chrome binary, and the ack arrives", async ({
    browserName,
  }, testInfo) => {
    expect(browserName).toBeDefined();
    // With no DISPLAY a headed Chrome cannot start at all, so the ack proves no X server was used.
    await withOpened(testInfo, { DISPLAY: "" }, async ({ pid }) => {
      const args = await commandLine(pid);
      expect(args.some((arg) => arg === "--headless" || arg.startsWith("--headless="))).toBe(true);
      expect(args.filter((arg) => arg.includes("remote-debugging"))).toEqual([]);
      const executable = await readlink(`/proc/${pid}/exe`);
      expect(basename(executable)).toBe("chrome");
      expect(executable).not.toMatch(/headless[-_]shell|chrome-for-testing|ms-playwright/i);
      const version = (await run(executable, ["--version"])).stdout.trim();
      expect(version).toMatch(/^Google Chrome \d+\./);
      testInfo.annotations.push({ type: "chrome", description: version });
    });
  });

  test("no native window of the headless Chrome exists on the X server", async ({
    browserName,
  }, testInfo) => {
    expect(browserName).toBeDefined();
    // The display is available here: a headed Chrome would own a window, a headless one owns none.
    await withOpened(testInfo, {}, async (_opened, root) => {
      const { stdout } = await run("pgrep", ["-f", `user-data-dir=${root}`]);
      const pids = new Set(stdout.split("\n").filter(Boolean).map(Number));
      expect(pids.size).toBeGreaterThan(0);
      const owners = await windowOwners("chrome");
      expect(owners.filter((owner) => pids.has(owner))).toEqual([]);
    });
  });

  test("diagnostic: Browser.getVersion in headless reports the product", async ({
    browserName,
  }, testInfo) => {
    expect(browserName).toBeDefined();
    const chrome = await launchChrome({ args: ["--headless"] });
    try {
      const info = (await chrome.cdp.send("Browser.getVersion")) as { product: string };
      testInfo.annotations.push({ type: "diagnostic", description: info.product });
      console.log(`diagnostic Browser.getVersion product=${info.product}`);
      expect(info.product).toMatch(/^Chrome\/\d+\./);
    } finally {
      await chrome.close();
    }
  });
});
