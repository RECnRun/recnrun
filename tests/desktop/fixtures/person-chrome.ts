// Google Chrome started as a person starts it: no debugging flags, remote debugging turned on at chrome://inspect.
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  click,
  findWindow,
  focus,
  geometryOf,
  key,
  pause,
  pixelAt,
  screenshot,
  typeText,
  until,
  type Geometry,
  type Rgb,
} from "./x11.ts";

const WINDOW = { width: 1280, height: 960 };
const EXIT_TIMEOUT_MS = 5_000;
/** The checkbox of chrome://inspect/#remote-debugging, from the window's corner at this size. */
const ALLOW_CHECKBOX = { x: 210, y: 211 };
/**
 * "Allow remote debugging?" is a bubble at the top center of the window: its Cancel and Allow
 * buttons are light blue, the gap between them and its body white. The page behind is dimmed.
 */
const DIALOG = {
  cancel: { x: 722, y: 274 },
  allow: { x: 806, y: 274 },
  gap: { x: 764, y: 274 },
  body: { x: 640, y: 300 },
};
/** The "Turn off in settings" button of Chrome's "controlled by automated test software" bar. */
const BANNER_BUTTON = { x: 821, y: 101 };
const lightBlue = ([red, green, blue]: Rgb) => blue > 240 && green < 240 && red < 230;
const white = ([red, green, blue]: Rgb) => red > 250 && green > 250 && blue > 250;
const brandBlue = ([red, green, blue]: Rgb) => blue > 180 && red < 80 && green < 150;

export interface PersonChrome {
  readonly userDataDir: string;
  /** The X window of the browser; focused before every key the person types. */
  readonly windowId: string;
  readonly geometry: Geometry;
  /** Stops Chrome and deletes its profile. */
  close(): Promise<void>;
}

/** Chrome reads CHROME_CONFIG_HOME on Linux, so the profile is the temporary home's default one. */
export const chromeEnv = (home: string) => ({
  ...process.env,
  HOME: home,
  CHROME_CONFIG_HOME: join(home, ".config"),
  LOCALAPPDATA: join(home, "AppData"),
  RECNRUN_FORBID_EGRESS: "1",
});

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const outcome = await Promise.race([exited, pause(EXIT_TIMEOUT_MS).then(() => "timeout")]);
  if (outcome !== "timeout") return;
  child.kill("SIGKILL");
  await exited;
}

/** Starts `google-chrome` on the home's default profile and waits for its window. */
export async function startChrome(home: string): Promise<PersonChrome> {
  const userDataDir = join(home, ".config", "google-chrome");
  const flags = [
    // Chrome runs as root in the test container, where its sandbox cannot start.
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    `--window-size=${WINDOW.width},${WINDOW.height}`,
    "--window-position=0,0",
    "about:blank",
  ];
  const child = spawn("google-chrome", flags, { env: chromeEnv(home), stdio: "ignore" });
  const windowId = await findWindow("Google Chrome$");
  const geometry = await geometryOf(windowId);
  return {
    userDataDir,
    windowId,
    geometry,
    close: async () => {
      await stop(child);
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

/** Opens a URL the way a person does: focus the window, Ctrl+L, type it, Enter. */
async function openUrl(chrome: PersonChrome, url: string): Promise<void> {
  await focus(chrome.windowId);
  await key("ctrl+l");
  await pause(300);
  await typeText(url);
  await key("Return");
}

/**
 * Turns "Allow remote debugging for this browser instance" on at chrome://inspect and waits for
 * Chrome to write DevToolsActivePort; answers the browser endpoint the file names.
 */
export async function enableRemoteDebugging(chrome: PersonChrome): Promise<string> {
  await openUrl(chrome, "chrome://inspect/#remote-debugging");
  await findWindow("Inspect with Chrome Developer Tools");
  await pause(1_000);
  await click(chrome.geometry.x + ALLOW_CHECKBOX.x, chrome.geometry.y + ALLOW_CHECKBOX.y);
  const file = join(chrome.userDataDir, "DevToolsActivePort");
  let content = "";
  await until(async () => {
    content = await readFile(file, "utf8").catch(() => "");
    return content.trimEnd().split("\n").length >= 2;
  }, `Chrome to write ${file}`);
  const [port = "", path = ""] = content.trimEnd().split("\n");
  return `ws://127.0.0.1:${port.trim()}${path.trim()}`;
}

/** Whether the "Allow remote debugging?" dialog is on the display now. */
async function dialogShown(chrome: PersonChrome): Promise<boolean> {
  const { x, y } = chrome.geometry;
  const at = (spot: { x: number; y: number }) => pixelAt(x + spot.x, y + spot.y);
  if (!lightBlue(await at(DIALOG.allow)) || !lightBlue(await at(DIALOG.cancel))) return false;
  return white(await at(DIALOG.gap)) && white(await at(DIALOG.body));
}

/** Whether the active tab shows Chrome's "being controlled by automated test software" bar. */
export async function bannerShown(chrome: PersonChrome): Promise<boolean> {
  const { x, y } = chrome.geometry;
  return brandBlue(await pixelAt(x + BANNER_BUTTON.x, y + BANNER_BUTTON.y));
}

/**
 * Allows the connection: the dialog comes up focused on Cancel, so Tab then space from the
 * keyboard; a prompt that did not take the keys is clicked on Allow instead.
 */
async function allowConnection(chrome: PersonChrome): Promise<void> {
  const gone = () => until(async () => !(await dialogShown(chrome)), "the dialog to close", 2_000);
  await focus(chrome.windowId);
  await key("Tab");
  await pause(150);
  await key("space");
  try {
    await gone();
  } catch {
    await click(chrome.geometry.x + DIALOG.allow.x, chrome.geometry.y + DIALOG.allow.y);
    await gone();
  }
}

export interface DialogWatcher {
  /** How many times Chrome asked. */
  readonly count: number;
  stop(): Promise<void>;
}

/** Answers every "Allow remote debugging?" with Allow, keeping a screenshot of each, until stopped. */
export function watchDialogs(chrome: PersonChrome, shot: (name: string) => string): DialogWatcher {
  let count = 0;
  let active = true;
  const loop = async () => {
    while (active) {
      if (await dialogShown(chrome)) {
        count += 1;
        await screenshot(shot(`dialog-${count}`));
        await allowConnection(chrome);
      }
      await pause(250);
    }
  };
  const done = loop();
  return {
    get count() {
      return count;
    },
    stop: async () => {
      active = false;
      await done;
    },
  };
}
