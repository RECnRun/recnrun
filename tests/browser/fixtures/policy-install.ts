import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { launchChrome } from "./chrome.ts";
import type { StrictChrome } from "./chrome.ts";
import { packCrx3 } from "./crx3.ts";

/*
 * The strict install (POC PLAN.md decision 5): a managed policy force-installs a CRX3 the harness
 * packs from the test build, served by an update server on the loopback, into Chrome started with
 * no remote-debugging flag. The test build has no `key`, so each install signs with a fresh one.
 */

const POLICY_FILE = "/etc/opt/chrome/policies/managed/recnrun.json";

/** The method cannot run here at all, as opposed to running and failing. */
export class UnavailableError extends Error {}

export interface PolicyInstall {
  id: string;
  version: string;
  /** Every request the update server answered, as `METHOD /path`, for the verdict. */
  requests: readonly string[];
  /** Writes the managed policy that force-installs the CRX. */
  writePolicy(): Promise<void>;
  /** Removes the policy file and stops the update server. */
  cleanup(): Promise<void>;
}

function policyUnavailability(): string | undefined {
  if (process.platform !== "linux") {
    return `Google Chrome reads ${POLICY_FILE} on Linux only; this host is ${process.platform}`;
  }
  const uid = process.getuid?.();
  if (uid !== 0) return `writing ${POLICY_FILE} needs root; the test runs as uid ${String(uid)}`;
  return undefined;
}

function updateManifest(id: string, version: string, codebase: string): string {
  const app = `<app appid='${id}'><updatecheck codebase='${codebase}' version='${version}'/></app>`;
  return `<?xml version='1.0' encoding='UTF-8'?><gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>${app}</gupdate>`;
}

async function serveUpdates(
  { id, version, crx }: { id: string; version: string; crx: Buffer },
  requests: string[],
): Promise<Server> {
  const server = createServer((request, response) => {
    const { port } = server.address() as AddressInfo;
    requests.push(`${request.method ?? "?"} ${request.url ?? ""}`);
    if (request.url?.startsWith("/updates.xml")) {
      response.setHeader("content-type", "text/xml");
      response.end(updateManifest(id, version, `http://127.0.0.1:${port}/extension.crx`));
    } else if (request.url === "/extension.crx") {
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

/** Packs the build at `path`, serves it on the loopback, and prepares its force-install policy. */
export async function preparePolicyInstall(path: string): Promise<PolicyInstall> {
  const unavailable = policyUnavailability();
  if (unavailable) throw new UnavailableError(unavailable);
  const packed = await packCrx3(path);
  const requests: string[] = [];
  const server = await serveUpdates(packed, requests);
  const { port } = server.address() as AddressInfo;
  const writePolicy = async (): Promise<void> => {
    const forcelist = [`${packed.id};http://127.0.0.1:${port}/updates.xml`];
    await mkdir(join(POLICY_FILE, ".."), { recursive: true });
    await writeFile(POLICY_FILE, JSON.stringify({ ExtensionInstallForcelist: forcelist }));
  };
  const cleanup = async (): Promise<void> => {
    await rm(POLICY_FILE, { force: true });
    await new Promise((resolve) => server.close(resolve));
  };
  return { id: packed.id, version: packed.version, requests, writePolicy, cleanup };
}

/** Chrome on `userDataDir` with no CDP client at all; the extension is observed without one. */
export const launchStrict = (userDataDir: string): Promise<StrictChrome> =>
  launchChrome({ cdp: false, userDataDir });

/** What the root records about an extension: its unpacked files and its preference entry. */
export interface InstalledState {
  onDisk: boolean;
  location?: number;
  disableReasons?: unknown;
}

async function preferenceEntry(userDataDir: string, id: string, file: string) {
  try {
    const text = await readFile(join(userDataDir, "Default", file), "utf8");
    const prefs = JSON.parse(text) as {
      extensions?: { settings?: Record<string, { location?: number; disable_reasons?: unknown }> };
    };
    return prefs.extensions?.settings?.[id];
  } catch {
    return undefined;
  }
}

/** Read from the root's files, the harness's own observation; Chrome writes them as it quits. */
export async function installedState(userDataDir: string, id: string): Promise<InstalledState> {
  const directory = join(userDataDir, "Default", "Extensions", id);
  const onDisk = await stat(directory).then(
    (found) => found.isDirectory(),
    () => false,
  );
  const entry =
    (await preferenceEntry(userDataDir, id, "Secure Preferences")) ??
    (await preferenceEntry(userDataDir, id, "Preferences"));
  if (!entry) return { onDisk };
  return { onDisk, location: entry.location, disableReasons: entry.disable_reasons };
}
