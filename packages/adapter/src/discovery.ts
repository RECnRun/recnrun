import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { ChromeChannel, DiscoveryErrorCode, DiscoveryResult } from "@recnrun/protocol";

export interface DiscoveryFileSystem {
  readFile(path: string): Promise<string>;
}

/** Where to look; platform, env, fs, and probe are injectable so tests need no real Chrome. */
export interface DiscoverOptions {
  userDataDir?: string;
  channel?: ChromeChannel;
  platform?: string;
  env?: Record<string, string | undefined>;
  fs?: DiscoveryFileSystem;
  probe?: (port: number) => Promise<boolean>;
}

const ACTIVE_PORT_FILE = "DevToolsActivePort";
const PROBE_TIMEOUT_MS = 500;
const KEEP_OPEN =
  "enable remote debugging at chrome://inspect/#remote-debugging and keep Chrome open";

// Folder names per channel, as Chromium's chrome_paths_{mac,win,linux} define them.
const MAC_FOLDERS = {
  stable: "Chrome",
  beta: "Chrome Beta",
  dev: "Chrome Dev",
  canary: "Chrome Canary",
};
const WINDOWS_FOLDERS = {
  stable: "Chrome",
  beta: "Chrome Beta",
  dev: "Chrome Dev",
  canary: "Chrome SxS",
};
const LINUX_FOLDERS = {
  stable: "google-chrome",
  beta: "google-chrome-beta",
  dev: "google-chrome-unstable",
  canary: "google-chrome-canary",
};

const nodeFileSystem: DiscoveryFileSystem = { readFile: (path) => readFile(path, "utf8") };

/** The default user-data dir of a Chrome channel on a platform. */
function defaultUserDataDir(
  channel: ChromeChannel,
  platform: string,
  env: Record<string, string | undefined>,
): string {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? win32.join(env.USERPROFILE ?? homedir(), "AppData", "Local");
    return win32.join(local, "Google", WINDOWS_FOLDERS[channel], "User Data");
  }
  const home = env.HOME ?? homedir();
  if (platform === "darwin") {
    return posix.join(home, "Library", "Application Support", "Google", MAC_FOLDERS[channel]);
  }
  const config = env.CHROME_CONFIG_HOME ?? env.XDG_CONFIG_HOME ?? posix.join(home, ".config");
  return posix.join(config, LINUX_FOLDERS[channel]);
}

/** True when something accepts a TCP connection on the loopback port. */
function probeLoopbackPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const settle = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

function failure(code: DiscoveryErrorCode, userDataDir: string, detail: string): DiscoveryResult {
  const remedy = `${detail} To let RECnRun connect, ${KEEP_OPEN}.`;
  return { ok: false, code, remedy, userDataDir };
}

function parseActivePort(content: string): { port: number; path: string } | undefined {
  const [portLine = "", path = ""] = content.split(/\r?\n/).map((line) => line.trim());
  const port = /^\d+$/.test(portLine) ? Number(portLine) : 0;
  if (port < 1 || port > 65_535 || !path.startsWith("/devtools/browser/")) return undefined;
  return { port, path };
}

async function readActivePort(fs: DiscoveryFileSystem, file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

function locate(options: DiscoverOptions): { userDataDir: string; file: string } {
  const platform = options.platform ?? process.platform;
  const userDataDir =
    options.userDataDir ??
    defaultUserDataDir(options.channel ?? "stable", platform, options.env ?? process.env);
  const file = (platform === "win32" ? win32 : posix).join(userDataDir, ACTIVE_PORT_FILE);
  return { userDataDir, file };
}

/** Finds the CDP endpoint of a running Chrome through `<userDataDir>/DevToolsActivePort`. */
export async function discover(options: DiscoverOptions = {}): Promise<DiscoveryResult> {
  const { userDataDir, file } = locate(options);
  const content = await readActivePort(options.fs ?? nodeFileSystem, file);
  if (content === undefined) {
    return failure("missing-file", userDataDir, `Chrome has not written ${file}.`);
  }
  const parsed = parseActivePort(content);
  if (!parsed) {
    return failure("malformed-file", userDataDir, `${file} is not a port and a browser path.`);
  }
  const { port, path } = parsed;
  if (!(await (options.probe ?? probeLoopbackPort)(port))) {
    const detail = `${file} names port ${port}, but nothing listens there; Chrome was closed or restarted.`;
    return failure("stale-file", userDataDir, detail);
  }
  const wsEndpoint = `ws://127.0.0.1:${port}${path}`;
  return { ok: true, wsEndpoint, userDataDir, source: "active-port-file", port, path };
}
