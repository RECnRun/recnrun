import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { CdpClosedError, connectWebSocket, evaluateInServiceWorker } from "./cdp-client.ts";
import type { CdpClient } from "./cdp-client.ts";
import { launchChrome } from "./chrome.ts";
import type { ChromeLaunchOptions, LaunchedChrome } from "./chrome.ts";

/** The test build `vp run --no-cache extension#build:test` writes; its manifest has no `key`. */
export const EXTENSION_PATH = fileURLToPath(
  new URL("../../../apps/extension/.output/chrome-mv3-test", import.meta.url),
);

/** Flag Chrome requires before it accepts `Extensions.loadUnpacked` (POC PLAN.md decision 5). */
const UNSAFE_EXTENSION_DEBUGGING = "--enable-unsafe-extension-debugging";
const SELF_ID = "chrome.runtime.id";
const BACKGROUND_TIMEOUT_MS = 15_000;
const ANSWER_RETRY_MS = 100;

/** The diagnostic install: CDP is connected, so nothing it shows approves a cell. */
export interface LoadedExtension {
  method: "loadUnpacked";
  label: "diagnostic";
  extensionId: string;
  chrome: LaunchedChrome;
  /** Evaluates an expression in the extension's service worker, awaiting a returned promise. */
  evaluateInBackground(expression: string): Promise<unknown>;
  close(): Promise<void>;
}

/** A just-started worker can be attached before its `chrome` bindings exist, so retry until it answers. */
async function firstAnswer(evaluate: (expression: string) => Promise<unknown>): Promise<unknown> {
  const deadline = Date.now() + BACKGROUND_TIMEOUT_MS;
  for (;;) {
    try {
      return await evaluate(SELF_ID);
    } catch (error) {
      // A closed connection cannot recover, so retrying would only wait out the deadline.
      if (error instanceof CdpClosedError || Date.now() > deadline) throw error;
      await delay(ANSWER_RETRY_MS);
    }
  }
}

/**
 * Pings the extension's worker in a running Chrome: it must answer with its own id. Leaves Chrome
 * running when the ping fails, so a caller can still install the build into it.
 */
export async function attachExtension(
  chrome: LaunchedChrome,
  extensionId: string,
): Promise<LoadedExtension> {
  const client: CdpClient = await connectWebSocket(chrome.wsEndpoint);
  const evaluateInBackground = (expression: string) =>
    evaluateInServiceWorker(client, extensionId, expression, BACKGROUND_TIMEOUT_MS);
  try {
    const answered = await firstAnswer(evaluateInBackground);
    if (answered !== extensionId) {
      throw new Error(`chrome.runtime.id answered ${String(answered)}, not ${extensionId}`);
    }
  } catch (error) {
    client.close();
    throw error;
  }
  const close = async (): Promise<void> => {
    client.close();
    await chrome.close();
  };
  return {
    method: "loadUnpacked",
    label: "diagnostic",
    extensionId,
    chrome,
    evaluateInBackground,
    close,
  };
}

export interface UnpackedOptions extends Pick<ChromeLaunchOptions, "executable" | "userDataDir"> {
  transport?: "port" | "pipe";
  /** Flags after `--enable-unsafe-extension-debugging`. */
  args?: readonly string[];
}

/** Google Chrome Stable started so that it accepts `Extensions.loadUnpacked`. */
export function launchForUnpacked({
  transport = "port",
  args = [],
  ...rest
}: UnpackedOptions = {}) {
  return launchChrome({
    ...rest,
    args: [UNSAFE_EXTENSION_DEBUGGING, ...args],
    pipe: transport === "pipe",
  });
}

/** Installs the build at `path` over CDP and returns its id. */
async function installUnpacked(chrome: LaunchedChrome, path: string): Promise<string> {
  const params = { path };
  const loaded = chrome.pipe
    ? await chrome.pipe.send<{ id: string }>("Extensions.loadUnpacked", params)
    : await chrome.cdp.send("Extensions.loadUnpacked", params);
  return loaded.id;
}

/** The diagnostic method: `Extensions.loadUnpacked` with `--enable-unsafe-extension-debugging`. */
export async function loadUnpacked(
  path: string,
  options: UnpackedOptions = {},
): Promise<LoadedExtension> {
  const chrome = await launchForUnpacked(options);
  try {
    return await attachExtension(chrome, await installUnpacked(chrome, path));
  } catch (error) {
    await chrome.close();
    throw error;
  }
}
