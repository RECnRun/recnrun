import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { loadUnpacked } from "../../browser/fixtures/extension-loaders.ts";
import type { LoadedExtension, UnpackedOptions } from "../../browser/fixtures/extension-loaders.ts";

/** The D0 variant `vp run --no-cache extension#build:poc-d0` writes, with its pinned key. */
const POC_D0_PATH = fileURLToPath(
  new URL("../../../apps/extension/.output/chrome-mv3-poc-d0", import.meta.url),
);
// The id the POC manifests pin with apps/extension/scripts/poc-key.mjs.
const POC_EXTENSION_ID = "omllgeochjfpkjbkpcgjmnnbncdpiedd";
const READY_TIMEOUT_MS = 10_000;

/** Where a cell's downloads go: a folder inside the root, or Chrome's own default. */
export interface DownloadPreferences {
  location: "custom" | "default";
  /** Chrome's "Ask where to save each file before downloading". */
  prompt?: boolean;
}

export interface ProbeItem {
  id: number;
  filename: string;
  state: string;
  error?: string;
  exists?: boolean;
  bytesReceived?: number;
}

export type Reply<T> = { ok: true; result: T } | { ok: false; error: string };

interface ProbeOptions {
  conflictAction?: "uniquify" | "overwrite" | "prompt";
  filename?: string;
  url?: string;
  settle?: boolean;
}

interface TolerantRead {
  publication?: { profileId: string; createdAt: number };
  reason: string;
}

/** The diagnostics page's `window.__poc`, which sends the extension's own messages. */
export interface Diagnostics {
  probe(namespace: string, content: string, options?: ProbeOptions): Promise<Reply<ProbeItem>>;
  cancel(id: number): Promise<Reply<ProbeItem>>;
  search(id?: number): Promise<Reply<{ count: number; items: ProbeItem[] }>>;
  readBack(path: string): Promise<{ ok: boolean; url?: string; text?: string; error?: string }>;
  readPublication(path: string, previous: unknown): Promise<TolerantRead>;
}

/** A launched D0 build with its diagnostics page open, on a root whose downloads go to `directory`. */
export interface ProbeChrome {
  loaded: LoadedExtension;
  diagnostics: Diagnostics;
  page: Page;
  /** The custom download folder, or undefined when Chrome uses its default. */
  directory: string | undefined;
}

/** Written before the first launch, so Chrome starts with these download settings. */
async function writeDownloadPreferences(
  root: string,
  directory: string | undefined,
  prompt: boolean,
) {
  const custom = directory ? { default_directory: directory, directory_upgrade: true } : {};
  const preferences = {
    download: { prompt_for_download: prompt, ...custom },
    ...(directory ? { savefile: { default_directory: directory } } : {}),
  };
  await mkdir(join(root, "Default"), { recursive: true });
  await writeFile(join(root, "Default", "Preferences"), JSON.stringify(preferences));
}

type PocWindow = { __poc?: Record<string, ((...args: unknown[]) => Promise<unknown>) | undefined> };

function diagnosticsOf(page: Page): Diagnostics {
  const call = (name: string, ...args: unknown[]) =>
    page.evaluate(
      ([method, values]) => {
        const poc = (window as unknown as PocWindow).__poc;
        const run = poc?.[method];
        if (!run) throw new Error(`window.__poc.${method} is not defined on the diagnostics page`);
        return run(...values);
      },
      [name, args] as const,
    );
  return {
    probe: (namespace, content, options = {}) =>
      call("probe", namespace, content, options) as Promise<Reply<ProbeItem>>,
    cancel: (id) => call("cancel", id) as Promise<Reply<ProbeItem>>,
    search: (id) =>
      call("search", ...(id === undefined ? [] : [id])) as ReturnType<Diagnostics["search"]>,
    readBack: (path) => call("readBack", path) as ReturnType<Diagnostics["readBack"]>,
    readPublication: (path, previous) =>
      call("readPublication", path, previous) as Promise<TolerantRead>,
  };
}

/** Writes the root's download settings, installs D0 over CDP, and opens its diagnostics page. */
export async function launchProbe(
  root: string,
  preferences: DownloadPreferences,
  options: Omit<UnpackedOptions, "userDataDir"> = {},
): Promise<ProbeChrome> {
  const directory = preferences.location === "custom" ? join(root, "downloads") : undefined;
  await writeDownloadPreferences(root, directory, preferences.prompt === true);
  const loaded = await loadUnpacked(POC_D0_PATH, { ...options, userDataDir: root });
  try {
    if (loaded.extensionId !== POC_EXTENSION_ID) {
      throw new Error(`D0 installed as ${loaded.extensionId}, not the pinned ${POC_EXTENSION_ID}`);
    }
    // connectOverCDP routes every download to its own folder under GUID names; give Chrome its own.
    await loaded.chrome.cdp.send("Browser.setDownloadBehavior", { behavior: "default" });
    const [context] = loaded.chrome.browser.contexts();
    if (!context) throw new Error("Chrome has no default browser context");
    const page = await context.newPage();
    await page.goto(`chrome-extension://${POC_EXTENSION_ID}/diagnostics.html`);
    const loading = () => document.getElementById("diagnostics")?.textContent !== "Loading…";
    await page.waitForFunction(loading, undefined, { timeout: READY_TIMEOUT_MS });
    return { loaded, diagnostics: diagnosticsOf(page), page, directory };
  } catch (error) {
    await loaded.close();
    throw error;
  }
}

/** A loopback source that sends its first bytes and then stalls, so a download stays in progress. */
export async function stallingSource() {
  const open = new Set<ServerResponse>();
  /** The Range header of every request, so a resumed download shows. */
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.headers.range ?? "no range");
    open.add(response);
    response.writeHead(200, { "content-type": "application/json", "content-length": 4 << 20 });
    response.write("x".repeat(256 << 10));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const abort = () => {
    for (const response of open) response.destroy();
    open.clear();
  };
  const close = () =>
    new Promise<void>((resolve) => {
      abort();
      server.close(() => resolve());
    });
  return { url: `http://127.0.0.1:${port}/stall.json`, requests, abort, close };
}
