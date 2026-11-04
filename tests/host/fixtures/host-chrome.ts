import { readFile, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test as base } from "@playwright/test";
import type { TestInfo } from "@playwright/test";
import { launchChrome } from "../../browser/fixtures/chrome.ts";
import type { StrictChrome } from "../../browser/fixtures/chrome.ts";
import {
  EXTENSION_PATH,
  extensionPath,
  loadUnpacked,
} from "../../browser/fixtures/extension-loaders.ts";
import type {
  BuildVariant,
  LoadedExtension,
  UnpackedOptions,
} from "../../browser/fixtures/extension-loaders.ts";
import { CHROME_BINARY, evidence, hostRunId, requireHost } from "./host-env.ts";
import type { Evidence } from "./host-env.ts";
import { launchOnRoot } from "./host-launch.ts";
import { removeHostRoot, rootFor } from "./roots.ts";

export { expect } from "@playwright/test";

/** Keeps the diagnostic window off the owner's screen; the owner may be using the machine. */
const OFFSCREEN = ["--window-position=-2000,0", "--window-size=800,600"];
/** Never reads the owner's Chrome Safe Storage key from the login Keychain. */
const HOST_FLAGS = ["--no-default-browser-check", "--use-mock-keychain"];
const PREFERENCES_POLL_MS = 1_000;

/** How long the strict method waits for the owner's `Load unpacked`; RECNRUN_HOST_GESTURE_TIMEOUT_MS. */
export const GESTURE_TIMEOUT_MS = Number(process.env.RECNRUN_HOST_GESTURE_TIMEOUT_MS ?? 300_000);

/** The diagnostic method: `Extensions.loadUnpacked` over CDP on a throwaway root. */
export interface HostExtension extends LoadedExtension {
  root: string;
  /** The build this launch installed. */
  path: string;
  evidence: Evidence;
  /** Stops only the Chrome this launch spawned and keeps the root, for a relaunch on it. */
  quit(): Promise<void>;
  /** Stops only the Chrome this launch spawned, then removes its root. */
  close(): Promise<void>;
}

/** The host's launch options on `root`: the installed Chrome, mock keychain, window offscreen. */
export const hostUnpackedOptions = (root: string): UnpackedOptions => ({
  executable: CHROME_BINARY,
  userDataDir: root,
  args: [...HOST_FLAGS, ...OFFSCREEN],
});

/** The strict method: no debugging flag; the owner installed the build with `Load unpacked`. */
export interface HostStrict {
  method: "Load unpacked";
  label: "strict";
  chrome: StrictChrome;
  root: string;
  extensionId: string;
  evidence: Evidence;
}

function rootName(method: string, headless: boolean, testInfo: TestInfo): string {
  // Headless is a separate runner (POC PLAN.md P7); the host layer validates headed Chrome.
  if (headless) throw new Error("Host tests run Chrome headed; set use.headless to false.");
  return `${method}-${testInfo.testId}-${testInfo.retry}`;
}

const newRoot = (name: string): Promise<string> => rootFor(requireHost(), hostRunId(), name);

/** Deletes this run's marked root and its run folder once empty, unless RECNRUN_HOST_KEEP_ROOTS=1. */
async function removeRoot(root: string): Promise<void> {
  if (process.env.RECNRUN_HOST_KEEP_ROOTS === "1") return;
  await removeHostRoot(root, hostRunId());
  await rmdir(dirname(root)).catch(() => undefined);
}

type Settings = Record<string, { path?: string; location?: number }>;

/** The id Chrome recorded for an unpacked build at `path`, from the root's own preference files. */
async function unpackedId(root: string, path: string): Promise<string | undefined> {
  for (const file of ["Secure Preferences", "Preferences"]) {
    const text = await readFile(join(root, "Default", file), "utf8").catch(() => "{}");
    const settings = (JSON.parse(text) as { extensions?: { settings?: Settings } }).extensions
      ?.settings;
    const found = Object.entries(settings ?? {}).find(([, entry]) => entry.path === path);
    if (found) return found[0];
  }
  return undefined;
}

async function waitForGesture(chrome: StrictChrome, root: string): Promise<string> {
  console.log(
    [
      `Strict host run: Google Chrome is open on the throwaway root ${root}.`,
      "In that window open chrome://extensions, turn on Developer mode, choose Load unpacked,",
      `and select ${EXTENSION_PATH}. Waiting up to ${GESTURE_TIMEOUT_MS} ms.`,
    ].join("\n"),
  );
  const deadline = Date.now() + GESTURE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (chrome.exited())
      throw new Error(`Chrome exited before the install:\n${chrome.diagnostics()}`);
    const id = await unpackedId(root, EXTENSION_PATH);
    if (id) return id;
    await delay(PREFERENCES_POLL_MS);
  }
  throw new Error(`No Load unpacked of ${EXTENSION_PATH} within ${GESTURE_TIMEOUT_MS} ms.`);
}

/**
 * Launches the installed Chrome on a fresh root under RECNRUN_HOST_ROOTS and installs a build:
 * `path` (the test build by default, for chrome.spec.ts) or the build of `variant`.
 */
export async function openHostExtension(
  name: string,
  {
    variant = "test",
    path = extensionPath(variant),
  }: { variant?: BuildVariant; path?: string } = {},
): Promise<HostExtension> {
  const root = await newRoot(name);
  const record = evidence();
  const launched = await launchOnRoot<LoadedExtension>({
    launch: () => loadUnpacked(path, hostUnpackedOptions(root)),
    after: async (loaded) => {
      const { product, userAgent } = await loaded.chrome.cdp.send("Browser.getVersion");
      await record.versions({ version: loaded.chrome.version, product, userAgent });
    },
    stop: (loaded) => loaded.close(),
    removeRoot: () => removeRoot(root),
  });
  const close = async (): Promise<void> => {
    try {
      await launched.close();
    } finally {
      await removeRoot(root);
    }
  };
  return { ...launched, root, path, evidence: record, quit: () => launched.close(), close };
}

export const test = base.extend<{ hostExtension: HostExtension; hostStrict: HostStrict }>({
  hostExtension: async ({ headless }, use, testInfo) => {
    const opened = await openHostExtension(rootName("diagnostic", headless, testInfo));
    try {
      await use(opened);
    } finally {
      await opened.close();
    }
  },
  hostStrict: async ({ headless }, use, testInfo) => {
    const root = await newRoot(rootName("strict", headless, testInfo));
    const record = evidence();
    try {
      const options = { executable: CHROME_BINARY, userDataDir: root, silentDebugger: false };
      const chrome = await launchChrome({ cdp: false, ...options, args: HOST_FLAGS });
      try {
        await record.versions({ version: chrome.version });
        const extensionId = await waitForGesture(chrome, root);
        const strict = { method: "Load unpacked", label: "strict" } as const;
        await use({ ...strict, chrome, root, extensionId, evidence: record });
      } finally {
        await chrome.close();
      }
    } finally {
      await removeRoot(root);
    }
  },
});
