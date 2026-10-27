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
 * two File System Access prompts are bubbles over the browser window; xdotool drives
 * all three. The picker is found by its title, the browser window by a title the driver gives
 * its page, and each bubble by what it does to the display: the write prompt dims the page,
 * and the restore prompt's buttons are light blue. There is no window manager, so every window
 * gets focus explicitly.
 */

const exec = promisify(execFile);
const PICKER_TITLE = "^Select (a folder|where) this site";
/**
 * Where the restore prompt's buttons sit, from the browser window's corner, at its default size.
 * A popup window has no toolbar, so the prompt hangs higher than from a normal window's omnibox;
 * the popup's spots come first, since a normal window's spot for one button falls on another.
 */
const RESTORE_BUTTONS = [
  { x: 90, y: { "this-time": 177, "every-visit": 220, deny: 263 } },
  { x: 290, y: { "this-time": 268, "every-visit": 310, deny: 353 } },
] as const;
/** A spot of page background under the toolbar, which the write prompt dims. */
const PAGE_CORNER = { x: 30, y: 140 };
interface Spot {
  x: number;
  y: number;
}

const dimmed = ([red]: Rgb) => red < 160;
const lightBlue = ([red, green, blue]: Rgb) => blue > 240 && green < 240 && red < 230;

type RestoreAnswer = keyof (typeof RESTORE_BUTTONS)[number]["y"];

interface NativeDialogs {
  /** Types the folder's path into the picker and opens it (Return would cancel instead). */
  chooseFolder(path: string): Promise<void>;
  cancelPicker(): Promise<void>;
  /** "Allow this site to edit files?", which comes up focused on Don't allow. */
  answerWritePrompt(answer: "allow" | "deny"): Promise<void>;
  /** The three-button restore prompt, for a grant that ended; Chrome gives it no focus, so a click answers. */
  answerRestorePrompt(answer: RestoreAnswer): Promise<void>;
  /**
   * Allows the folder in whichever prompt Chrome shows, on every visit for the restore prompt,
   * and says which it was: within one session Chrome may show either once a grant has ended.
   */
  allowInEitherPrompt(): Promise<"write" | "restore">;
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

/**
 * The visible windows whose title matches. Searched again on failure: Ubuntu's xdotool
 * 3.20160805 predates the fix for #335 and exits on BadWindow when any window closes meanwhile.
 */
async function findWindow(title: string): Promise<string> {
  let found = "";
  await until(async () => {
    found = await xdotool("search", "--sync", "--onlyvisible", "--name", title).catch(() => "");
    return found !== "";
  }, `the window "${title}" to show`);
  return found;
}

const pickerWindow = () => findWindow(PICKER_TITLE);

async function windowOrigin(id: string): Promise<{ x: number; y: number }> {
  const geometry = await xdotool("getwindowgeometry", "--shell", id);
  const at = (axis: "X" | "Y") => Number(new RegExp(`^${axis}=(\\d+)$`, "m").exec(geometry)?.[1]);
  return { x: at("X"), y: at("Y") };
}

/** Waits until the pixel at the window's offset looks (or no longer looks) like `shown`. */
async function bubble(id: string, at: Spot, shown: (rgb: Rgb) => boolean) {
  const origin = await windowOrigin(id);
  const check = async () => shown(await pixelAt(origin.x + at.x, origin.y + at.y));
  return {
    at,
    visible: check,
    appears: () => until(check, "Chrome's prompt to show"),
    closes: () => until(async () => !(await check()), "Chrome's prompt to close"),
  };
}

type Bubble = Awaited<ReturnType<typeof bubble>>;

/** Polls every spot until one shows its bubble, and returns the first that does. */
async function firstShown(bubbles: Bubble[]): Promise<Bubble> {
  let found: Bubble | undefined;
  await until(async () => {
    for (const each of bubbles) if (!found && (await each.visible())) found = each;
    return found !== undefined;
  }, "Chrome's prompt to show");
  if (!found) throw new Error("No prompt showed.");
  return found;
}

let windows = 0;

/** Answers the write prompt from the keyboard, since it takes the focus. */
async function answerWrite(id: string, prompt: Bubble, answer: "allow" | "deny") {
  await xdotool("windowfocus", "--sync", id);
  if (answer === "deny") await xdotool("key", "Return");
  else {
    await xdotool("key", "Tab");
    await pause(200);
    await xdotool("key", "space");
  }
  await prompt.closes();
}

/** Clicks the restore prompt's button that `prompt` found shown. */
async function clickRestore(id: string, prompt: Bubble) {
  const { x, y } = await windowOrigin(id);
  await xdotool("mousemove", "--sync", String(x + prompt.at.x), String(y + prompt.at.y));
  await xdotool("click", "1");
  await prompt.closes();
}

const restoreButtons = (id: string, answer: RestoreAnswer) =>
  Promise.all(
    RESTORE_BUTTONS.map((buttons) => bubble(id, { x: buttons.x, y: buttons.y[answer] }, lightBlue)),
  );

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
    const id = await findWindow(`^${title}( - |$)`);
    // A button under the pointer, left there by the last answer, is no longer light blue; no
    // --sync, which waits forever when the pointer is there already.
    await xdotool("mousemove", "0", "0");
    return id;
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
      await answerWrite(id, prompt, answer);
    },
    async answerRestorePrompt(answer) {
      // No windowraise: raising the browser window covers a prompt Chrome already shows.
      const id = await browserWindow();
      await clickRestore(id, await firstShown(await restoreButtons(id, answer)));
    },
    async allowInEitherPrompt() {
      const id = await browserWindow();
      const write = await bubble(id, PAGE_CORNER, dimmed);
      const prompt = await firstShown([write, ...(await restoreButtons(id, "every-visit"))]);
      if (prompt === write) {
        await answerWrite(id, write, "allow");
        return "write";
      }
      await clickRestore(id, prompt);
      return "restore";
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
