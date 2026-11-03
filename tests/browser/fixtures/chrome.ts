import { execFile, spawn } from "node:child_process";
import type { ChildProcess, StdioOptions } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { chromium, test as base } from "@playwright/test";
import type { Browser, CDPSession } from "@playwright/test";
import type { Readable, Writable } from "node:stream";
import { connectPipe } from "./cdp-client.ts";
import type { CdpClient } from "./cdp-client.ts";

export { expect } from "@playwright/test";

const ACTIVE_PORT_TIMEOUT_MS = 20_000;
const ACTIVE_PORT_POLL_MS = 50;
const EXIT_TIMEOUT_MS = 5_000;
const VERSION_TIMEOUT_MS = 10_000;
const STDERR_TAIL = 4_000;
const MACOS_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const REMEDY =
  "Install Google Chrome Stable, set RECNRUN_CHROME_PATH to its executable, or run `vp run test:browser`, whose Docker image includes it.";

export interface ChromeLaunchOptions {
  /** Flags appended to the base set; later tasks add only what PLAN.md decision 5 allows. */
  args?: readonly string[];
  /** Another Chromium build, such as Playwright's, for runs labelled `diagnostic` (PLAN.md decision 3). */
  executable?: string;
  /** Also open `--remote-debugging-pipe` (fds 3 and 4) next to the port, for pipe-only CDP commands. */
  pipe?: boolean;
  /** A profile to reuse, as E6 does to restart Chrome on it; the caller owns it, so close() keeps it. */
  userDataDir?: string;
  /** `false` leaves out `--silent-debugger-extension-api`; the infobar spec is the one reason. */
  silentDebugger?: boolean;
}

/** The strict lab (E8): no `--remote-debugging-*` flag, so no CDP client can exist at all. */
export interface StrictLaunchOptions extends Omit<ChromeLaunchOptions, "pipe"> {
  cdp: false;
}

interface ChromeProcess {
  /** Output of `<executable> --version`, for example `Google Chrome 156.0.8078.79`. */
  version: string;
  executable: string;
  userDataDir: string;
  pid: number;
  /** The exact argument list Chrome was started with. */
  flags: readonly string[];
  close(): Promise<void>;
}

export interface LaunchedChrome extends ChromeProcess {
  strict?: false;
  browser: Browser;
  /** A CDP session on the browser target, for `Browser.*` and `Target.*` commands. */
  cdp: CDPSession;
  wsEndpoint: string;
  /** The `--remote-debugging-pipe` connection, when launched with `pipe: true`. */
  pipe?: CdpClient;
}

/** Chrome launched with `cdp: false`: the types leave no CDP handle to use by mistake. */
export interface StrictChrome extends ChromeProcess {
  strict: true;
  browser?: never;
  cdp?: never;
  wsEndpoint?: never;
  pipe?: never;
  /** Whether the process is gone, and what it printed on stderr, for a loader's failure message. */
  exited(): boolean;
  diagnostics(): string;
}

interface WatchedProcess {
  child: ChildProcess;
  args: readonly string[];
  exited: () => boolean;
  diagnostics: () => string;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveChromePath(): string {
  const configured = process.env.RECNRUN_CHROME_PATH;
  if (configured) {
    if (isExecutable(configured)) return configured;
    throw new Error(`RECNRUN_CHROME_PATH (${configured}) is not an executable file. ${REMEDY}`);
  }
  const directories = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const onPath = ["google-chrome", "google-chrome-stable"].flatMap((name) =>
    directories.map((directory) => join(directory, name)),
  );
  const found = [...onPath, MACOS_CHROME].find(isExecutable);
  if (!found) throw new Error(`Google Chrome was not found. ${REMEDY}`);
  return found;
}

function requireDisplay(): void {
  if (process.platform === "linux" && !process.env.DISPLAY) {
    throw new Error(
      "Headed Chrome needs a display. Run `vp run test:browser`, whose container provides Xvfb, or set DISPLAY.",
    );
  }
}

export function chromeFlags(
  userDataDir: string,
  extra: readonly string[] = [],
  silentDebugger = true,
  cdp = true,
): string[] {
  const port = cdp ? ["--remote-debugging-port=0"] : [];
  const flags = [`--user-data-dir=${userDataDir}`, ...port, "--no-first-run"];
  // Hides the "started debugging" infobar; it grants no capability (PLAN.md decision 5).
  if (silentDebugger) flags.push("--silent-debugger-extension-api");
  // Chrome runs as root in the test container, where its sandbox cannot start.
  if (process.env.RECNRUN_TEST_CONTAINER === "1") flags.push("--no-sandbox");
  return [...flags, ...extra, "about:blank"];
}

function watch(binary: string, flags: string[], pipe: boolean): WatchedProcess {
  const stdio: StdioOptions = pipe
    ? ["ignore", "ignore", "pipe", "pipe", "pipe"]
    : ["ignore", "ignore", "pipe"];
  const args = pipe ? ["--remote-debugging-pipe", ...flags] : flags;
  const child: ChildProcess = spawn(binary, args, { stdio });
  let stderr = "";
  let failure = "";
  child.stderr?.on("data", (data) => {
    stderr = (stderr + String(data)).slice(-STDERR_TAIL);
  });
  child.once("error", (error) => {
    failure = error.message;
  });
  return {
    child,
    args,
    exited: () => failure !== "" || child.exitCode !== null || child.signalCode !== null,
    diagnostics: () => [failure, stderr].filter(Boolean).join("\n"),
  };
}

async function waitForActivePort(file: string, chrome: WatchedProcess): Promise<string> {
  const deadline = Date.now() + ACTIVE_PORT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (chrome.exited()) {
      throw new Error(`Chrome exited before writing ${file}:\n${chrome.diagnostics()}`);
    }
    const content = await readFile(file, "utf8").catch(() => "");
    if (content.trimEnd().split("\n").length >= 2) return content;
    await delay(ACTIVE_PORT_POLL_MS);
  }
  throw new Error(
    `Chrome did not write ${file} within ${ACTIVE_PORT_TIMEOUT_MS} ms:\n${chrome.diagnostics()}`,
  );
}

function endpointFrom(content: string): string {
  const [portLine = "", wsPath = ""] = content
    .trimEnd()
    .split("\n")
    .map((line) => line.trim());
  const port = Number(portLine);
  const validPort = Number.isInteger(port) && port > 0 && port <= 65_535;
  if (!validPort || !wsPath.startsWith("/devtools/browser/")) {
    throw new Error(`Malformed DevToolsActivePort: ${JSON.stringify(content)}`);
  }
  return `ws://127.0.0.1:${port}${wsPath}`;
}

async function stop(chrome: WatchedProcess): Promise<void> {
  if (chrome.exited()) return;
  const exited = new Promise<void>((resolve) => chrome.child.once("exit", () => resolve()));
  chrome.child.kill("SIGTERM");
  const outcome = await Promise.race([exited, delay(EXIT_TIMEOUT_MS, "timeout")]);
  if (outcome !== "timeout") return;
  chrome.child.kill("SIGKILL");
  await exited;
}

interface Started {
  chrome: WatchedProcess;
  base: Omit<ChromeProcess, "close">;
  /** Stops Chrome and deletes a profile the launcher created. */
  stopAndClean: () => Promise<void>;
}

async function start(options: ChromeLaunchOptions, cdp: boolean): Promise<Started> {
  requireDisplay();
  const executable = options.executable ?? resolveChromePath();
  const run = promisify(execFile);
  const version = (await run(executable, ["--version"], { timeout: VERSION_TIMEOUT_MS })).stdout;
  const userDataDir = options.userDataDir ?? (await mkdtemp(join(tmpdir(), "recnrun-chrome-")));
  // The previous launch's port file would be read before this Chrome writes its own.
  await rm(join(userDataDir, "DevToolsActivePort"), { force: true });
  const flags = chromeFlags(userDataDir, options.args, options.silentDebugger, cdp);
  const chrome = watch(executable, flags, options.pipe === true);
  const stopAndClean = async (): Promise<void> => {
    await stop(chrome);
    if (options.userDataDir !== undefined) return;
    // Chrome's helper processes can still hold files for a moment after the browser exits.
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  const pid = chrome.child.pid ?? 0;
  const base = { version: version.trim(), executable, userDataDir, pid, flags: chrome.args };
  return { chrome, base, stopAndClean };
}

/** Chrome with no CDP client; whoever launches it confirms it through the extension under test. */
async function launchStrict(options: StrictLaunchOptions): Promise<StrictChrome> {
  const { chrome, base, stopAndClean } = await start(options, false);
  return {
    ...base,
    strict: true,
    exited: chrome.exited,
    diagnostics: chrome.diagnostics,
    close: stopAndClean,
  };
}

function isStrict(
  options: ChromeLaunchOptions | StrictLaunchOptions,
): options is StrictLaunchOptions {
  return "cdp" in options && options.cdp === false;
}

export async function launchChrome(options: StrictLaunchOptions): Promise<StrictChrome>;
export async function launchChrome(options?: ChromeLaunchOptions): Promise<LaunchedChrome>;
export async function launchChrome(
  options: ChromeLaunchOptions | StrictLaunchOptions = {},
): Promise<LaunchedChrome | StrictChrome> {
  if (isStrict(options)) return launchStrict(options);
  const { chrome, base, stopAndClean } = await start(options, true);
  const pipe = options.pipe
    ? connectPipe(chrome.child.stdio[3] as Writable, chrome.child.stdio[4] as Readable)
    : undefined;
  let browser: Browser | undefined;
  const close = async (): Promise<void> => {
    pipe?.close();
    await browser?.close().catch(() => undefined);
    await stopAndClean();
  };
  try {
    const port = join(base.userDataDir, "DevToolsActivePort");
    const wsEndpoint = endpointFrom(await waitForActivePort(port, chrome));
    browser = await chromium.connectOverCDP(wsEndpoint);
    const cdp = await browser.newBrowserCDPSession();
    return { ...base, browser, cdp, wsEndpoint, ...(pipe ? { pipe } : {}), close };
  } catch (error) {
    await close();
    throw error;
  }
}

export const test = base.extend<{ chromeArgs: string[]; chrome: LaunchedChrome }>({
  chromeArgs: [[], { option: true }],
  chrome: async ({ headless, chromeArgs }, use) => {
    // The browser layer validates headed Chrome only (PLAN.md decision 3).
    if (headless) throw new Error("Browser tests run Chrome headed; set use.headless to false.");
    const chrome = await launchChrome({ args: chromeArgs });
    try {
      await use(chrome);
    } finally {
      await chrome.close();
    }
  },
});
