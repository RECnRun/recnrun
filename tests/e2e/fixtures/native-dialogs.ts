import type { Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pixelAt, until } from "./display.ts";
import type { Rgb } from "./display.ts";
import { test as base } from "./profiles.ts";

/*
 * Chrome's folder picker is a GTK window of its own on the container's Xvfb display, and its
 * two File System Access prompts are bubbles drawn inside the browser window; xdotool drives
 * all three. The picker is found by its title, the browser window by a title the driver gives
 * its page, and each bubble by what it does to the display: the write prompt dims the page,
 * and the restore prompt's buttons are light blue. There is no window manager, so every window
 * gets focus explicitly.
 */

const exec = promisify(execFile);
const PICKER_TITLE = "^Select (a folder|where) this site";
/** Where the restore prompt's buttons sit, from the browser window's corner, at its default size. */
const RESTORE_BUTTON_X = 290;
const RESTORE_BUTTON_Y = { "this-time": 268, "every-visit": 310, deny: 353 } as const;
/** A spot of page background under the toolbar, which the write prompt dims. */
const PAGE_CORNER = { x: 30, y: 140 };
const dimmed = ([red]: Rgb) => red < 160;
const lightBlue = ([red, green, blue]: Rgb) => blue > 240 && green < 240 && red < 230;

type RestoreAnswer = keyof typeof RESTORE_BUTTON_Y;

interface NativeDialogs {
  /** Types the folder's path into the picker and opens it (Return would cancel instead). */
  chooseFolder(path: string): Promise<void>;
  cancelPicker(): Promise<void>;
  /** "Allow this site to edit files?", which comes up focused on Don't allow. */
  answerWritePrompt(answer: "allow" | "deny"): Promise<void>;
  /** The three-button prompt after a restart; Chrome gives it no focus, so a click answers. */
  answerRestorePrompt(answer: RestoreAnswer): Promise<void>;
}

export interface Native {
  /** Drives the dialogs `page` opens; call it before the click that opens the first one. */
  dialogs: (page: Page) => Promise<NativeDialogs>;
  /** An empty folder on the container's disk, removed after the test. */
  folder: string;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function xdotool(...args: string[]): Promise<string> {
  const { stdout } = await exec("xdotool", args, { timeout: 15_000 });
  return stdout.trim();
}

/** Resolves once no visible window matches the title; `search` exits 1 for no match. */
const windowGone = (title: string) =>
  until(
    async () => !(await xdotool("search", "--onlyvisible", "--name", title).catch(() => "")),
    `the window "${title}" to close`,
  );

async function pickerWindow(): Promise<string> {
  return xdotool("search", "--sync", "--onlyvisible", "--name", PICKER_TITLE);
}

async function windowOrigin(id: string): Promise<{ x: number; y: number }> {
  const geometry = await xdotool("getwindowgeometry", "--shell", id);
  const at = (axis: "X" | "Y") => Number(new RegExp(`^${axis}=(\\d+)$`, "m").exec(geometry)?.[1]);
  return { x: at("X"), y: at("Y") };
}

/** Waits until the pixel at the window's offset looks (or no longer looks) like `shown`. */
async function bubble(id: string, at: { x: number; y: number }, shown: (rgb: Rgb) => boolean) {
  const origin = await windowOrigin(id);
  const check = async () => shown(await pixelAt(origin.x + at.x, origin.y + at.y));
  return {
    appears: () => until(check, "Chrome's prompt to show"),
    closes: () => until(async () => !(await check()), "Chrome's prompt to close"),
  };
}

let windows = 0;

async function driverOf(page: Page): Promise<NativeDialogs> {
  if (!process.env.RECNRUN_TEST_CONTAINER)
    throw new Error(
      "Chrome's own dialogs are driven only in the test container (vp run test:e2e).",
    );
  const title = `recnrun-e2e-window-${++windows}`;
  // Chrome opens the picker only for the active tab.
  await page.bringToFront();
  // Playwright intercepts every file chooser unless told otherwise, and the picker never shows.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.setInterceptFileChooserDialog", { enabled: false });
  const browserWindow = async () => {
    await page.bringToFront();
    // Set on every call, since a reload restores the page's own title.
    await page.evaluate((name) => {
      document.title = name;
    }, title);
    return xdotool("search", "--sync", "--onlyvisible", "--name", `^${title}( - |$)`);
  };
  return {
    async chooseFolder(path) {
      await xdotool("windowfocus", "--sync", await pickerWindow());
      await xdotool("key", "--clearmodifiers", "ctrl+l");
      await pause(300);
      await xdotool("type", "--delay", "20", path);
      await pause(300);
      await xdotool("key", "alt+o");
      await windowGone(PICKER_TITLE);
    },
    async cancelPicker() {
      await xdotool("windowfocus", "--sync", await pickerWindow());
      await xdotool("key", "Escape");
      await windowGone(PICKER_TITLE);
    },
    async answerWritePrompt(answer) {
      const id = await browserWindow();
      const prompt = await bubble(id, PAGE_CORNER, dimmed);
      await prompt.appears();
      await xdotool("windowfocus", "--sync", id);
      if (answer === "deny") await xdotool("key", "Return");
      else {
        await xdotool("key", "Tab");
        await pause(200);
        await xdotool("key", "space");
      }
      await prompt.closes();
    },
    async answerRestorePrompt(answer) {
      const id = await browserWindow();
      await xdotool("windowraise", id);
      const at = { x: RESTORE_BUTTON_X, y: RESTORE_BUTTON_Y[answer] };
      const prompt = await bubble(id, at, lightBlue);
      await prompt.appears();
      const { x, y } = await windowOrigin(id);
      await xdotool("mousemove", "--sync", String(x + at.x), String(y + at.y));
      await xdotool("click", "1");
      await prompt.closes();
    },
  };
}

/** Every file under `dir` with the start of its content, for the failure report. */
const listing = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listing(path);
    return [`${path}: ${readFileSync(path, "utf8").slice(0, 400)}`];
  });

/** The profiles, plus Chrome's own dialogs and a folder on disk; a failure keeps the display. */
export const test = base.extend<{ native: Native }>({
  native: async ({ headless }, use, testInfo) => {
    if (headless) throw new Error("Chrome shows its dialogs only when headed.");
    const folder = mkdtempSync(join(tmpdir(), "recnrun-folder-"));
    await use({ dialogs: driverOf, folder });
    if (testInfo.status !== testInfo.expectedStatus) {
      await exec("scrot", [testInfo.outputPath("display.png")]).catch(() => {});
      writeFileSync(testInfo.outputPath("folder.txt"), listing(folder).join("\n"));
    }
    rmSync(folder, { recursive: true, force: true });
  },
});
