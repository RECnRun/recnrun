import { execFile } from "node:child_process";
import { readFile, readdir, readlink } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { TestInfo } from "@playwright/test";
import { expect, launchChrome, test } from "../browser/fixtures/chrome.ts";
import { chromesOf, labRig } from "../browser/fixtures/launcher-rig.ts";
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

/** The process singleton files Chrome keeps in a root while it runs. */
const singletonsOf = async (root: string) =>
  (await readdir(root)).filter((name) => name.startsWith("Singleton")).sort();

/** Stops the pid and confirms nothing of the root runs; on failure keeps the evidence and the root. */
async function stopOrKeep(rig: Awaited<ReturnType<typeof labRig>>, pid: number) {
  try {
    await quit(rig, [pid]);
  } catch (cause) {
    await rig.keep?.().catch(() => undefined);
    throw new Error(`Chrome survived on ${rig.scene.root}; the root is kept.`, { cause });
  }
  await rig.dispose();
}

/** A fresh poc-d0 root opened by `open.sh ... headless`; Chrome is always stopped, then the root removed. */
async function withOpened(
  testInfo: TestInfo,
  env: NodeJS.ProcessEnv,
  body: (opened: Opened, root: string) => Promise<void>,
) {
  const rig = await labRig(testInfo);
  let pid = 0;
  try {
    const opened = await runOpen({ scene: rig.scene, env: { ...rig.env, ...env } }, MODE);
    pid = opened.pid;
    expect(opened.code, opened.stderr).toBe(0);
    expect(opened.pid).toBeGreaterThan(0);
    expect(await ackProblems(rig.scene, opened)).toEqual([]);
    await body(opened, rig.scene.root);
  } catch (error) {
    await rig.keep?.().catch(() => undefined);
    throw error;
  } finally {
    await stopOrKeep(rig, pid);
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

  test("the harness's quit runs Chrome's full shutdown: no Singleton file stays in the root", async ({
    browserName,
  }, testInfo) => {
    expect(browserName).toBeDefined();
    const rig = await labRig(testInfo);
    let pid = 0;
    try {
      const opened = await runOpen({ scene: rig.scene, env: rig.env }, MODE);
      pid = opened.pid;
      expect(opened.code, opened.stderr).toBe(0);
      expect(await ackProblems(rig.scene, opened)).toEqual([]);
      expect(await singletonsOf(rig.scene.root)).toEqual([
        "SingletonCookie",
        "SingletonLock",
        "SingletonSocket",
      ]);
      await quit(rig, [pid]);
      pid = 0;
      // ProcessSingleton::Cleanup unlinks them only on the normal shutdown path.
      expect(await singletonsOf(rig.scene.root)).toEqual([]);
    } catch (error) {
      await rig.keep?.().catch(() => undefined);
      throw error;
    } finally {
      await stopOrKeep(rig, pid);
    }
  });

  test("a failing body still stops the Chrome it opened", async ({ browserName }, testInfo) => {
    expect(browserName).toBeDefined();
    let root = "";
    await expect(
      withOpened(testInfo, {}, async (_opened, opened) => {
        root = opened;
        throw new Error("forced failure");
      }),
    ).rejects.toThrow("forced failure");
    expect(root).not.toBe("");
    expect(await chromesOf(root), "Chrome left running on the removed root").toEqual([]);
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
