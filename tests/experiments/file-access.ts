import { access, cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { openPage } from "../browser/fixtures/cdp-client.ts";
import type { CdpClient } from "../browser/fixtures/cdp-client.ts";

/*
 * E1 (POC PLAN.md P1.2): the extension's file-scheme state, read from its own diagnostics page
 * and from the root's preferences.
 */

/** The id `apps/extension/scripts/poc-key.mjs` pins for every POC build. */
export const POC_EXTENSION_ID = "omllgeochjfpkjbkpcgjmnnbncdpiedd";
export const PROBE_FILE = "e1-probe.txt";
export const PROBE_TEXT = "RECnRun E1 probe: read through file:// by the extension\n";

const POLL_MS = 250;
const RENDER_TIMEOUT_MS = 5_000;
const ACCESS_TIMEOUT_MS = 15_000;

type Fetched =
  | { ok: true; status: number; matches: boolean; text: string }
  | { ok: false; name: string; message: string };

/** What the extension reports and gets: its API, the rendered diagnostics, and a file:// fetch. */
export interface FileRead {
  fileSchemeAccess: unknown;
  /** `fileSchemeAccess` as the diagnostics page rendered it. */
  rendered: unknown;
  fetch: Fetched;
}

/** Refuses a missing build before any sample, so a harness defect never becomes a verdict. */
export async function requireBuild(path: string, variant: string): Promise<void> {
  for (const file of ["manifest.json", "diagnostics.html"]) {
    await access(join(path, file)).catch(() => {
      throw new Error(
        `The ${variant} build has no ${file} at ${path}; run vp run --no-cache extension#build:${variant}.`,
      );
    });
  }
}

/**
 * Copies the build at `source` into `directory` without its `host_permissions`, the control that
 * separates the toggle from the manifest's own file host permission.
 */
export async function withoutHostPermissions(source: string, directory: string): Promise<string> {
  const build = join(directory, "build");
  await cp(source, build, { recursive: true });
  const file = join(build, "manifest.json");
  const { host_permissions: _dropped, ...manifest } = JSON.parse(
    await readFile(file, "utf8"),
  ) as Record<string, unknown>;
  await writeFile(file, JSON.stringify(manifest));
  return build;
}

/** Writes the probe with known bytes from Node, outside anything the extension controls. */
export async function writeProbe(directory: string): Promise<string> {
  const path = join(directory, PROBE_FILE);
  await writeFile(path, PROBE_TEXT);
  return path;
}

const readExpression = (url: string) => `(async () => {
  const fileSchemeAccess = await chrome.extension.isAllowedFileSchemeAccess();
  let rendered = null;
  try { rendered = JSON.parse(document.getElementById("diagnostics").textContent).fileSchemeAccess; } catch {}
  const fetched = await fetch(${JSON.stringify(url)}).then(
    async (response) => ({ ok: true, status: response.status, text: await response.text() }),
    (error) => ({ ok: false, name: error.name, message: error.message }),
  );
  return { fileSchemeAccess, rendered, fetched };
})()`;

interface RawRead {
  fileSchemeAccess: unknown;
  rendered: unknown;
  fetched: { ok: boolean; status?: number; text?: string; name?: string; message?: string };
}

function toRead({ fileSchemeAccess, rendered, fetched }: RawRead): FileRead {
  if (!fetched.ok) {
    const failure = {
      ok: false as const,
      name: String(fetched.name),
      message: String(fetched.message),
    };
    return { fileSchemeAccess, rendered, fetch: failure };
  }
  const text = String(fetched.text);
  const success = {
    ok: true as const,
    status: Number(fetched.status),
    matches: text === PROBE_TEXT,
    text,
  };
  return { fileSchemeAccess, rendered, fetch: success };
}

/** Opens `chrome-extension://<id>/diagnostics.html` and reads the probe from there. */
export async function readFromExtension(
  client: CdpClient,
  extensionId: string,
  probe: string,
): Promise<FileRead> {
  const page = await openPage(client, `chrome-extension://${extensionId}/diagnostics.html`);
  try {
    const deadline = Date.now() + RENDER_TIMEOUT_MS;
    for (;;) {
      const read = (await page.evaluate(readExpression(pathToFileURL(probe).href))) as RawRead;
      // The page renders its report after its own awaits; the API answer does not wait for it.
      if (read.rendered !== null || Date.now() > deadline) return toRead(read);
      await delay(POLL_MS);
    }
  } finally {
    await page.close();
  }
}

/** Reads until the API reports `expected` (a toggle reloads the extension), or returns the last read. */
export async function accessAfter(
  client: CdpClient,
  extensionId: string,
  probe: string,
  expected: boolean,
): Promise<FileRead> {
  const deadline = Date.now() + ACCESS_TIMEOUT_MS;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const read = await readFromExtension(client, extensionId, probe);
      if (read.fileSchemeAccess === expected) return read;
      last = read;
    } catch (error) {
      last = error;
    }
    await delay(POLL_MS);
  }
  if (last instanceof Error) throw last;
  return last as FileRead;
}

type Entry = { newAllowFileAccess?: unknown; creation_flags?: unknown };

/**
 * `extensions.settings.<id>.newAllowFileAccess` from the root's preference files, after a quit,
 * with the entry's `creation_flags` and keys, which tell a CDP install from a persistent one.
 */
export async function fileAccessPref(root: string, extensionId: string) {
  for (const file of ["Secure Preferences", "Preferences"]) {
    const text = await readFile(join(root, "Default", file), "utf8").catch(() => "{}");
    const prefs = JSON.parse(text) as { extensions?: { settings?: Record<string, Entry> } };
    const entry = prefs.extensions?.settings?.[extensionId];
    if (entry && "newAllowFileAccess" in entry) {
      const { newAllowFileAccess, creation_flags: creationFlags } = entry;
      return { newAllowFileAccess, file, creationFlags, keys: Object.keys(entry).sort() };
    }
  }
  return { newAllowFileAccess: null, file: null };
}
