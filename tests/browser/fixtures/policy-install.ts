import { existsSync } from "node:fs";
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
  /** Removes the policy file this install wrote, if unchanged, and stops the update server. */
  cleanup(): Promise<void>;
}

/** What the guard reads about where it runs; tests pass their own. */
export interface PolicyHost {
  platform: NodeJS.Platform;
  uid: number | undefined;
  env: NodeJS.ProcessEnv;
  dockerenv: boolean;
}

const currentHost = (): PolicyHost => ({
  platform: process.platform,
  uid: process.getuid?.(),
  env: process.env,
  dockerenv: existsSync("/.dockerenv"),
});

export function policyUnavailability(host: PolicyHost = currentHost()): string | undefined {
  if (host.platform !== "linux") {
    return `Google Chrome reads ${POLICY_FILE} on Linux only; this host is ${host.platform}`;
  }
  // A root `:local` run on a Linux host would otherwise rewrite that machine's own Chrome policy.
  if (host.env.RECNRUN_TEST_CONTAINER !== "1" || !host.dockerenv) {
    return `writing ${POLICY_FILE} happens only inside the test container (RECNRUN_TEST_CONTAINER=1 and /.dockerenv)`;
  }
  const { uid } = host;
  if (uid !== 0) return `writing ${POLICY_FILE} needs root; the test runs as uid ${String(uid)}`;
  return undefined;
}

/** A policy file this invocation created. */
export interface OwnedPolicy {
  /** Deletes the file only while it still holds what this invocation wrote. */
  remove(): Promise<void>;
}

/** Creates `file` exclusively, so a policy someone else wrote is never overwritten. */
export async function writeOwnedPolicy(file: string, content: string): Promise<OwnedPolicy> {
  await mkdir(join(file, ".."), { recursive: true });
  try {
    await writeFile(file, content, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(
      `${file} already exists; refusing to overwrite a policy this run did not write.`,
    );
  }
  const remove = async (): Promise<void> => {
    const now = await readFile(file, "utf8").catch(() => undefined);
    if (now === undefined) return;
    if (now !== content)
      throw new Error(`${file} changed; refusing to delete a policy this run did not write.`);
    await rm(file);
  };
  return { remove };
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
  let owned: OwnedPolicy | undefined;
  const writePolicy = async (): Promise<void> => {
    const forcelist = [`${packed.id};http://127.0.0.1:${port}/updates.xml`];
    owned = await writeOwnedPolicy(
      POLICY_FILE,
      JSON.stringify({ ExtensionInstallForcelist: forcelist }),
    );
  };
  const cleanup = async (): Promise<void> => {
    try {
      await owned?.remove();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
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
