import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { discover, type DiscoveryFileSystem } from "../src/index.ts";

const BROWSER_PATH = "/devtools/browser/0f3c2a6e-6a43-4f0f-9a4c-3b2b1e7c9d10";
const REMEDY = /chrome:\/\/inspect\/#remote-debugging.*keep Chrome open/;

let userDataDir = "";
let server: Server | undefined;

function listen(): Promise<number> {
  const listening = createServer((socket) => socket.end());
  server = listening;
  return new Promise((resolve) => {
    listening.listen(0, "127.0.0.1", () => {
      const address = listening.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

async function closedPort(): Promise<number> {
  const port = await listen();
  await new Promise((resolve) => server?.close(resolve));
  server = undefined;
  return port;
}

function writeActivePort(content: string): Promise<void> {
  return writeFile(join(userDataDir, "DevToolsActivePort"), content);
}

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), "recnrun-discovery-"));
});

afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
  await rm(userDataDir, { recursive: true, force: true });
});

describe("discover with a user-data dir", () => {
  test("resolves the endpoint of a valid DevToolsActivePort", async () => {
    const port = await listen();
    await writeActivePort(`${port}\n${BROWSER_PATH}\n`);
    expect(await discover({ userDataDir })).toEqual({
      ok: true,
      wsEndpoint: `ws://127.0.0.1:${port}${BROWSER_PATH}`,
      userDataDir,
      source: "active-port-file",
      port,
      path: BROWSER_PATH,
    });
  });

  test("tolerates Windows line endings", async () => {
    const port = await listen();
    await writeActivePort(`${port}\r\n${BROWSER_PATH}`);
    expect(await discover({ userDataDir })).toMatchObject({ ok: true, port, path: BROWSER_PATH });
  });

  test("reports a missing file with the remedy", async () => {
    const result = await discover({ userDataDir });
    expect(result).toMatchObject({ ok: false, code: "missing-file", userDataDir });
    expect(result.ok ? "" : result.remedy).toMatch(REMEDY);
  });

  test.each([
    ["a port that is not a number", `abc\n${BROWSER_PATH}`],
    ["a port of zero", `0\n${BROWSER_PATH}`],
    ["a port above 65535", `65536\n${BROWSER_PATH}`],
    ["a fractional port", `92.5\n${BROWSER_PATH}`],
    ["a missing path", "9222\n"],
    ["a page path", "9222\n/devtools/page/0f3c"],
    ["an empty file", ""],
  ])("reports a malformed file: %s", async (_name, content) => {
    await writeActivePort(content);
    const result = await discover({ userDataDir });
    expect(result).toMatchObject({ ok: false, code: "malformed-file" });
    expect(result.ok ? "" : result.remedy).toMatch(REMEDY);
  });

  test("reports a stale file when nothing listens on its port", async () => {
    const port = await closedPort();
    await writeActivePort(`${port}\n${BROWSER_PATH}\n`);
    const result = await discover({ userDataDir });
    expect(result).toMatchObject({ ok: false, code: "stale-file", userDataDir });
    expect(result.ok ? "" : result.remedy).toMatch(REMEDY);
    expect(result.ok ? "" : result.remedy).toContain(String(port));
  });

  test("uses an injected port probe", async () => {
    await writeActivePort(`9222\n${BROWSER_PATH}\n`);
    const probed: number[] = [];
    const probe = (port: number) => Promise.resolve(probed.push(port) > 0);
    expect(await discover({ userDataDir, probe })).toMatchObject({ ok: true, port: 9222 });
    expect(probed).toEqual([9222]);
  });

  test("rethrows a read error other than a missing or blocked file", async () => {
    await mkdir(join(userDataDir, "DevToolsActivePort"));
    await expect(discover({ userDataDir })).rejects.toThrow(/EISDIR/);
  });

  test.each(["EPERM", "EACCES"])(
    "reports a file the operating system refuses to let it read (%s)",
    async (code) => {
      const file = join(userDataDir, "DevToolsActivePort");
      const fs: DiscoveryFileSystem = {
        readFile: () =>
          Promise.reject(
            Object.assign(new Error(`${code}: operation not permitted, open '${file}'`), { code }),
          ),
      };
      const result = await discover({ userDataDir, fs });
      expect(result).toMatchObject({ ok: false, code: "unreadable-file", userDataDir });
      const remedy = result.ok ? "" : result.remedy;
      expect(remedy).toContain(file);
      expect(remedy).toMatch(/macOS blocks .* from reading Google Chrome's data/);
      expect(remedy).toContain("System Settings → Privacy & Security → Full Disk Access");
      expect(remedy).toContain("access data from other apps");
      expect(remedy).toMatch(/restart/);
      expect(remedy).not.toContain("chrome://inspect");
    },
  );
});

function recordingFs(): { fs: DiscoveryFileSystem; read: string[] } {
  const read: string[] = [];
  const fs: DiscoveryFileSystem = {
    readFile: (path) => {
      read.push(path);
      return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    },
  };
  return { fs, read };
}

describe("default user-data dir", () => {
  const macHome = "/Users/ada";
  const linuxHome = "/home/ada";
  const local = String.raw`C:\Users\ada\AppData\Local`;

  test.each([
    ["darwin", "stable", `${macHome}/Library/Application Support/Google/Chrome`],
    ["darwin", "beta", `${macHome}/Library/Application Support/Google/Chrome Beta`],
    ["darwin", "dev", `${macHome}/Library/Application Support/Google/Chrome Dev`],
    ["darwin", "canary", `${macHome}/Library/Application Support/Google/Chrome Canary`],
    ["win32", "stable", String.raw`${local}\Google\Chrome\User Data`],
    ["win32", "beta", String.raw`${local}\Google\Chrome Beta\User Data`],
    ["win32", "dev", String.raw`${local}\Google\Chrome Dev\User Data`],
    ["win32", "canary", String.raw`${local}\Google\Chrome SxS\User Data`],
    ["linux", "stable", `${linuxHome}/.config/google-chrome`],
    ["linux", "beta", `${linuxHome}/.config/google-chrome-beta`],
    ["linux", "dev", `${linuxHome}/.config/google-chrome-unstable`],
    ["linux", "canary", `${linuxHome}/.config/google-chrome-canary`],
  ] as const)("%s %s", async (platform, channel, expected) => {
    const { fs, read } = recordingFs();
    const home = platform === "darwin" ? macHome : linuxHome;
    const env = { HOME: home, LOCALAPPDATA: local };
    const result = await discover({ channel, platform, env, fs });
    expect(result).toMatchObject({ ok: false, code: "missing-file", userDataDir: expected });
    const separator = platform === "win32" ? "\\" : "/";
    expect(read).toEqual([`${expected}${separator}DevToolsActivePort`]);
  });

  test("defaults to the stable channel", async () => {
    const { fs } = recordingFs();
    const result = await discover({ platform: "linux", env: { HOME: linuxHome }, fs });
    expect(result).toMatchObject({ userDataDir: `${linuxHome}/.config/google-chrome` });
  });

  test("follows XDG_CONFIG_HOME and CHROME_CONFIG_HOME on Linux", async () => {
    const { fs } = recordingFs();
    const xdg = { HOME: linuxHome, XDG_CONFIG_HOME: "/xdg" };
    expect(await discover({ platform: "linux", env: xdg, fs })).toMatchObject({
      userDataDir: "/xdg/google-chrome",
    });
    const chromeHome = { ...xdg, CHROME_CONFIG_HOME: "/chrome-config" };
    expect(await discover({ platform: "linux", env: chromeHome, fs })).toMatchObject({
      userDataDir: "/chrome-config/google-chrome",
    });
  });

  test("falls back to the profile folder when LOCALAPPDATA is unset on Windows", async () => {
    const { fs } = recordingFs();
    const env = { USERPROFILE: String.raw`C:\Users\ada` };
    expect(await discover({ platform: "win32", env, fs })).toMatchObject({
      userDataDir: String.raw`C:\Users\ada\AppData\Local\Google\Chrome\User Data`,
    });
  });

  test("an explicit user-data dir wins over the channel", async () => {
    const { fs } = recordingFs();
    const result = await discover({ userDataDir: "/profiles/a", channel: "beta", fs });
    expect(result).toMatchObject({ userDataDir: "/profiles/a" });
  });
});

test("reads an explicit DevToolsActivePort file and reports its folder", async () => {
  const port = await listen();
  const activePortFile = join(userDataDir, "DevToolsActivePort");
  await writeActivePort(`${port}\n${BROWSER_PATH}\n`);
  expect(await discover({ activePortFile })).toMatchObject({ ok: true, port, userDataDir });
});
