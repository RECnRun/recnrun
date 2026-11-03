import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { hostRoots } from "./roots.ts";

/** The installed Google Chrome of this Mac (POC PLAN.md decision 3); never Playwright's Chromium. */
const CHROME_APP = "/Applications/Google Chrome.app";
export const CHROME_BINARY = join(CHROME_APP, "Contents/MacOS/Google Chrome");

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;
const run = promisify(execFile);

/** Throws unless this is the Mac host with Google Chrome installed and RECNRUN_HOST_ROOTS valid. */
export function requireHost(): string {
  if (process.env.RECNRUN_TEST_CONTAINER === "1" || process.platform !== "darwin") {
    throw new Error("`vp run test:host` runs only on the macOS host, never in Docker.");
  }
  try {
    accessSync(CHROME_BINARY, constants.X_OK);
  } catch {
    throw new Error(
      `Google Chrome was not found at ${CHROME_BINARY}; install it from google.com/chrome.`,
    );
  }
  return hostRoots();
}

/** The run id the Playwright config sets once per run; it names the roots and the evidence. */
export function hostRunId(): string {
  const id = process.env.RECNRUN_RUN_ID;
  if (!id) throw new Error("RECNRUN_RUN_ID is not set; run through playwright.host.config.ts.");
  return id;
}

/** The version the app bundle declares, read natively rather than written twice in the tests. */
export async function installedChromeVersion(): Promise<string> {
  const plist = join(CHROME_APP, "Contents/Info.plist");
  const extract = ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist];
  return (await run("plutil", extract)).stdout.trim();
}

async function macos(): Promise<{ version: string; build: string }> {
  const version = (await run("sw_vers", ["-productVersion"])).stdout.trim();
  const build = (await run("sw_vers", ["-buildVersion"])).stdout.trim();
  return { version, build };
}

/** Writes JSON evidence under `.artifacts/evidence/host/<run>/`, the only place host runs write. */
export interface Evidence {
  directory: string;
  write(file: string, data: unknown): Promise<string>;
  read(file: string): Promise<unknown>;
  /** `versions.json`: Chrome's `--version` and `Browser.getVersion` product, and macOS. */
  versions(chrome: { version: string; product?: string; userAgent?: string }): Promise<string>;
}

export function evidence(): Evidence {
  const directory = join(REPO, ".artifacts/evidence/host", hostRunId());
  const path = (file: string) => {
    if (!SAFE_FILE.test(file)) throw new Error(`Unsafe evidence file name: ${file}`);
    return join(directory, file);
  };
  const write = async (file: string, data: unknown) => {
    await mkdir(directory, { recursive: true });
    await writeFile(path(file), `${JSON.stringify(data, null, 2)}\n`);
    return path(file);
  };
  const read = async (file: string) => JSON.parse(await readFile(path(file), "utf8")) as unknown;
  const versions = async (chrome: { version: string; product?: string; userAgent?: string }) =>
    write("versions.json", {
      environment: "host",
      chrome: chrome.version,
      product: chrome.product ?? null,
      userAgent: chrome.userAgent ?? null,
      installed: await installedChromeVersion(),
      macos: await macos(),
      arch: process.arch,
      node: process.version,
      binary: CHROME_BINARY,
    });
  return { directory, write, read, versions };
}
