import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { chromium, test as base } from "@playwright/test";
import type { Browser, CDPSession } from "@playwright/test";

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
}

export interface LaunchedChrome {
  browser: Browser;
  /** A CDP session on the browser target, for `Browser.*` and `Target.*` commands. */
  cdp: CDPSession;
  /** Output of `<executable> --version`, for example `Google Chrome 156.0.8078.79`. */
  version: string;
  executable: string;
  userDataDir: string;
  wsEndpoint: string;
  pid: number;
  close(): Promise<void>;
}

interface WatchedProcess {
  child: ChildProcess;
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

function resolveChromePath(): string {
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

function chromeFlags(userDataDir: string, extra: readonly string[] = []): string[] {
  const flags = [
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    // Hides the "started debugging" infobar; it grants no capability (PLAN.md decision 5).
    "--silent-debugger-extension-api",
  ];
  // Chrome runs as root in the test container, where its sandbox cannot start.
  if (process.env.RECNRUN_TEST_CONTAINER === "1") flags.push("--no-sandbox");
  return [...flags, ...extra, "about:blank"];
}

function watch(binary: string, flags: string[]): WatchedProcess {
  const child = spawn(binary, flags, { stdio: ["ignore", "ignore", "pipe"] });
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

export async function launchChrome(options: ChromeLaunchOptions = {}): Promise<LaunchedChrome> {
  requireDisplay();
  const executable = resolveChromePath();
  const run = promisify(execFile);
  const version = (await run(executable, ["--version"], { timeout: VERSION_TIMEOUT_MS })).stdout;
  const userDataDir = await mkdtemp(join(tmpdir(), "recnrun-chrome-"));
  const chrome = watch(executable, chromeFlags(userDataDir, options.args));
  let browser: Browser | undefined;
  const close = async (): Promise<void> => {
    await browser?.close().catch(() => undefined);
    await stop(chrome);
    // Chrome's helper processes can still hold files for a moment after the browser exits.
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  try {
    const activePort = await waitForActivePort(join(userDataDir, "DevToolsActivePort"), chrome);
    const wsEndpoint = endpointFrom(activePort);
    browser = await chromium.connectOverCDP(wsEndpoint);
    const cdp = await browser.newBrowserCDPSession();
    const pid = chrome.child.pid ?? 0;
    return {
      browser,
      cdp,
      version: version.trim(),
      executable,
      userDataDir,
      wsEndpoint,
      pid,
      close,
    };
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
