// Starts Google Chrome on a fresh profile; shared by the browser fixtures and scripts/bench-capture.mjs.
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const ACTIVE_PORT_TIMEOUT_MS = 20_000;
const ACTIVE_PORT_POLL_MS = 50;
const EXIT_TIMEOUT_MS = 5_000;
const VERSION_TIMEOUT_MS = 10_000;
const STDERR_TAIL = 4_000;
const MACOS_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const REMEDY =
  "Install Google Chrome Stable, set RECNRUN_CHROME_PATH to its executable, or run `vp run test:browser`, whose Docker image includes it.";

export interface ChromeInstance {
  userDataDir: string;
  port: number;
  wsPath: string;
  wsEndpoint: string;
  version: string;
  pid: number;
  /** Raw contents of `<userDataDir>/DevToolsActivePort`. */
  activePort: string;
  /** Waits for this Chrome to exit (stopping it if needed) and starts another on the same profile. */
  relaunch(): Promise<ChromeInstance>;
}

export interface LaunchedChrome extends ChromeInstance {
  close(): Promise<void>;
}

interface WatchedProcess {
  child: ChildProcess;
  exit: Promise<void>;
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

function chromeArguments(userDataDir: string): string[] {
  const flags = [
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
  ];
  // Chrome runs as root in the test container, where its sandbox cannot start.
  if (process.env.RECNRUN_TEST_CONTAINER === "1") flags.push("--no-sandbox");
  return [...flags, "about:blank"];
}

function watch(binary: string, userDataDir: string): WatchedProcess {
  const child = spawn(binary, chromeArguments(userDataDir), {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  let failure = "";
  child.stderr?.on("data", (data) => {
    stderr = (stderr + String(data)).slice(-STDERR_TAIL);
  });
  const exit = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", (error) => {
      failure = error.message;
      resolve();
    });
  });
  return {
    child,
    exit,
    exited: () => failure !== "" || child.exitCode !== null || child.signalCode !== null,
    diagnostics: () => [failure, stderr].filter(Boolean).join("\n"),
  };
}

// After a crash the previous file stays behind, so a relaunch waits for different contents.
async function waitForActivePort(
  file: string,
  chrome: WatchedProcess,
  previous: string,
): Promise<string> {
  const deadline = Date.now() + ACTIVE_PORT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (chrome.exited()) {
      throw new Error(`Chrome exited before writing ${file}:\n${chrome.diagnostics()}`);
    }
    const content = await readFile(file, "utf8").catch(() => "");
    if (content !== previous && content.trimEnd().split("\n").length >= 2) return content;
    await delay(ACTIVE_PORT_POLL_MS);
  }
  throw new Error(
    `Chrome did not write ${file} within ${ACTIVE_PORT_TIMEOUT_MS} ms:\n${chrome.diagnostics()}`,
  );
}

function parseActivePort(content: string): { port: number; wsPath: string } {
  const [portLine = "", wsPath = ""] = content
    .trimEnd()
    .split("\n")
    .map((line) => line.trim());
  const port = Number(portLine);
  const validPort = Number.isInteger(port) && port > 0 && port <= 65_535;
  if (!validPort || !wsPath.startsWith("/devtools/browser/")) {
    throw new Error(`Malformed DevToolsActivePort: ${JSON.stringify(content)}`);
  }
  return { port, wsPath };
}

async function stop(chrome: WatchedProcess): Promise<void> {
  if (chrome.exited()) return;
  chrome.child.kill("SIGTERM");
  const outcome = await Promise.race([chrome.exit, delay(EXIT_TIMEOUT_MS, "timeout")]);
  if (outcome !== "timeout") return;
  chrome.child.kill("SIGKILL");
  await chrome.exit;
}

/** Starts Chrome on `userDataDir`, or on a new temporary folder; `close()` deletes the folder. */
export async function launchChrome(
  options: { userDataDir?: string } = {},
): Promise<LaunchedChrome> {
  requireDisplay();
  const binary = resolveChromePath();
  const run = promisify(execFile);
  const version = (await run(binary, ["--version"], { timeout: VERSION_TIMEOUT_MS })).stdout.trim();
  const userDataDir = options.userDataDir ?? (await mkdtemp(join(tmpdir(), "recnrun-chrome-")));
  await mkdir(userDataDir, { recursive: true });
  let current: WatchedProcess | undefined;
  const close = async (): Promise<void> => {
    if (current) await stop(current);
    // Chrome's helper processes can still hold files for a moment after the browser exits.
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  const boot = async (previous: string): Promise<LaunchedChrome> => {
    const chrome = watch(binary, userDataDir);
    current = chrome;
    const activePort = await waitForActivePort(
      join(userDataDir, "DevToolsActivePort"),
      chrome,
      previous,
    );
    const { port, wsPath } = parseActivePort(activePort);
    const wsEndpoint = `ws://127.0.0.1:${port}${wsPath}`;
    const pid = chrome.child.pid ?? 0;
    const relaunch = async (): Promise<LaunchedChrome> => {
      await stop(chrome);
      return boot(activePort);
    };
    return { userDataDir, port, wsPath, wsEndpoint, version, pid, activePort, close, relaunch };
  };
  try {
    return await boot("");
  } catch (error) {
    await close();
    throw error;
  }
}
