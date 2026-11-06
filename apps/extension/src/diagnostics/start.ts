import { errorMessage } from "@recnrun/domain";
import { browser } from "wxt/browser";
import { downloadMessages } from "@/diagnostics/poc-messages";
import { installReadFile } from "@/diagnostics/read-file";
import { installReadRegistry } from "@/diagnostics/read-registry";
import { installRenewCertificate } from "@/diagnostics/renew-certificate";
import { browserProfileSources } from "@/diagnostics/profile-sources";
import { buildReport } from "@/diagnostics/report";
import type { Presence } from "@/p2p/folder-rendezvous";
import { fileUrlFor, readTolerant } from "@/p2p/downloads-rendezvous";

/** Reads a file Chrome reported through the same file:// path the rendezvous will use. */
export async function readBack(absolutePath: string, fetcher: typeof fetch = fetch) {
  try {
    const url = fileUrlFor(absolutePath);
    const response = await fetcher(url);
    return { ok: true, url, text: await response.text() };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** Installs `window.__poc`, fills `<pre id="diagnostics">` with the report, and returns it. */
export async function startDiagnostics(page: Window & typeof globalThis = window) {
  const send = (message: unknown) => browser.runtime.sendMessage(message);
  const poc = {
    ...downloadMessages(send),
    readBack,
    /** The tolerant reader over a file:// read; a failed read counts as a temporary error. */
    readPublication: async (absolutePath: string, previous: Presence | undefined) => {
      const read = await readBack(absolutePath);
      return readTolerant(read.ok ? read.text : undefined, previous);
    },
  };
  Object.assign(page, { __poc: poc });
  installReadFile(page, send);
  installReadRegistry(page);
  installRenewCertificate(page);
  const report = await buildReport({
    extensionId: browser.runtime.id,
    mode: import.meta.env.MODE,
    permissions: browser.runtime.getManifest().permissions ?? [],
    isAllowedFileSchemeAccess: () => browser.extension.isAllowedFileSchemeAccess(),
    isAllowedIncognitoAccess: () => browser.extension.isAllowedIncognitoAccess(),
    // The page is a POC entrypoint: no production build contains it.
    profile: browserProfileSources(),
  });
  const target = page.document.getElementById("diagnostics");
  if (target) target.textContent = JSON.stringify(report, null, 2);
  return report;
}
