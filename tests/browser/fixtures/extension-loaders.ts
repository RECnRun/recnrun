import { realpathSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { CdpClosedError, connectWebSocket, evaluateInServiceWorker } from "./cdp-client.ts";
import type { CdpClient } from "./cdp-client.ts";
import { launchChrome } from "./chrome.ts";
import type { LaunchedChrome } from "./chrome.ts";
import { extensionIdFrom, packCrx3 } from "./crx3.ts";

/** The three ways E0 tries, in the loader's order (docs/poc/namespace-sessions/experiments/E0.md). */
export type LoadMethod = "cdp-load-unpacked" | "managed-policy" | "chromium-load-extension";

export interface LoadedExtension {
  method: LoadMethod;
  /** Set when the browser is not Google Chrome Stable (PLAN.md decision 3). */
  label?: "diagnostic";
  extensionId: string;
  chrome: LaunchedChrome;
  /** Evaluates an expression in the extension's service worker, awaiting a returned promise. */
  evaluateInBackground(expression: string): Promise<unknown>;
  close(): Promise<void>;
}

/** The method cannot run here at all, as opposed to running and failing. */
export class UnavailableError extends Error {}

/** Flag Chrome requires before it accepts `Extensions.loadUnpacked` (PLAN.md decision 5). */
const UNSAFE_EXTENSION_DEBUGGING = "--enable-unsafe-extension-debugging";
const POLICY_FILE = "/etc/opt/chrome/policies/managed/recnrun.json";
const SELF_ID = "chrome.management.getSelf().then((self) => self.id)";
const BACKGROUND_TIMEOUT_MS = 15_000;
const ANSWER_RETRY_MS = 100;

/** A just-started worker can be attached before its `chrome` bindings exist, so retry until it answers. */
async function firstAnswer(evaluate: (expression: string) => Promise<unknown>): Promise<unknown> {
  const deadline = Date.now() + BACKGROUND_TIMEOUT_MS;
  for (;;) {
    try {
      return await evaluate(SELF_ID);
    } catch (error) {
      const refused = error instanceof Error && error.message.startsWith("Target.attachToTarget");
      // A closed connection cannot recover, so retrying would only wait out the deadline.
      if (refused || error instanceof CdpClosedError || Date.now() > deadline) throw error;
      await delay(ANSWER_RETRY_MS);
    }
  }
}

async function settle(
  chrome: LaunchedChrome,
  method: LoadMethod,
  extensionId: string,
  cleanup: () => Promise<void> = async () => undefined,
): Promise<LoadedExtension> {
  let client: CdpClient | undefined;
  const close = async (): Promise<void> => {
    client?.close();
    await chrome.close();
    await cleanup();
  };
  try {
    client = await connectWebSocket(chrome.wsEndpoint);
    const connected = client;
    const evaluateInBackground = (expression: string) =>
      evaluateInServiceWorker(connected, extensionId, expression, BACKGROUND_TIMEOUT_MS);
    // A method passes only when the extension's own background answers.
    const answered = await firstAnswer(evaluateInBackground);
    if (answered !== extensionId) {
      throw new Error(`management.getSelf() answered ${String(answered)}, not ${extensionId}`);
    }
    const label = method === "chromium-load-extension" ? { label: "diagnostic" as const } : {};
    return { method, ...label, extensionId, chrome, evaluateInBackground, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export interface LoadUnpackedOptions {
  transport?: "port" | "pipe";
  /** E0's control turns the flag off to see whether Chrome still requires it. */
  unsafeDebugging?: boolean;
  /** Loads into this existing profile instead of a new one (E6 restarts Chrome on it). */
  userDataDir?: string;
}

/** Hypothesis (a): `Extensions.loadUnpacked` over the port, or over `--remote-debugging-pipe`. */
export async function loadUnpackedOverCdp(
  path: string,
  { transport = "port", unsafeDebugging = true, userDataDir }: LoadUnpackedOptions = {},
): Promise<LoadedExtension> {
  const pipe = transport === "pipe";
  const args = unsafeDebugging ? [UNSAFE_EXTENSION_DEBUGGING] : [];
  const chrome = await launchChrome({ args, pipe, ...(userDataDir ? { userDataDir } : {}) });
  let id: string;
  try {
    const params = { path };
    const loaded = chrome.pipe
      ? await chrome.pipe.send<{ id: string }>("Extensions.loadUnpacked", params)
      : await chrome.cdp.send("Extensions.loadUnpacked", params);
    id = loaded.id;
  } catch (error) {
    await chrome.close();
    throw error;
  }
  return settle(chrome, "cdp-load-unpacked", id);
}

function policyUnavailability(): string | undefined {
  if (process.platform !== "linux") {
    return `Google Chrome reads managed policy files from ${POLICY_FILE} on Linux only; this host is ${process.platform}`;
  }
  const uid = process.getuid?.();
  if (uid !== 0) return `writing ${POLICY_FILE} needs root; the test runs as uid ${String(uid)}`;
  return undefined;
}

async function serveUpdates(id: string, version: string, crx: Buffer): Promise<Server> {
  const server = createServer((request, response) => {
    const { port } = server.address() as AddressInfo;
    if (request.url?.startsWith("/updates.xml")) {
      response.setHeader("content-type", "text/xml");
      const codebase = `http://127.0.0.1:${port}/isolator.crx`;
      const app = `<app appid='${id}'><updatecheck codebase='${codebase}' version='${version}'/></app>`;
      response.end(
        `<?xml version='1.0' encoding='UTF-8'?><gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>${app}</gupdate>`,
      );
    } else if (request.url === "/isolator.crx") {
      response.setHeader("content-type", "application/x-chrome-extension");
      response.end(crx);
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

/**
 * Hypothesis (b): `ExtensionSettings` force-installs a harness-packed CRX3 from a loopback update
 * server. `allowDevTools` adds `DeveloperToolsAvailability: 1`; Chrome's default refuses DevTools,
 * and so CDP attachment, on policy-installed extensions.
 */
export async function forceInstallByPolicy(
  path: string,
  allowDevTools = true,
): Promise<LoadedExtension> {
  const unavailable = policyUnavailability();
  if (unavailable) throw new UnavailableError(unavailable);
  const { id, version, crx } = await packCrx3(path);
  const server = await serveUpdates(id, version, crx);
  const cleanup = async (): Promise<void> => {
    await rm(POLICY_FILE, { force: true });
    await new Promise((resolve) => server.close(resolve));
  };
  try {
    const { port } = server.address() as AddressInfo;
    const update_url = `http://127.0.0.1:${port}/updates.xml`;
    const policy = {
      ...(allowDevTools ? { DeveloperToolsAvailability: 1 } : {}),
      ExtensionSettings: { [id]: { installation_mode: "force_installed", update_url } },
    };
    await mkdir(join(POLICY_FILE, ".."), { recursive: true });
    await writeFile(POLICY_FILE, JSON.stringify(policy));
    return await settle(await launchChrome(), "managed-policy", id, cleanup);
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Hypothesis (c): Playwright's Chromium, which still honours `--load-extension`; diagnostic only. */
export async function loadInChromium(path: string): Promise<LoadedExtension> {
  const executable = chromium.executablePath();
  const chrome = await launchChrome({ executable, args: [`--load-extension=${path}`] });
  // Chromium derives an unpacked extension's id from its absolute path.
  return settle(
    chrome,
    "chromium-load-extension",
    extensionIdFrom(Buffer.from(realpathSync(path))),
  );
}
