import { browser } from "wxt/browser";
import { errorMessage } from "@recnrun/domain";
import type { Presence } from "@/p2p/folder-rendezvous";
import { installReadFile } from "@/diagnostics/read-file";
import { fileUrlFor, readTolerant } from "@/p2p/downloads-rendezvous";

interface ProbeOptions {
  conflictAction?: "uniquify" | "overwrite" | "prompt";
  filename?: string;
  url?: string;
  settle?: boolean;
}

/** Reads a file Chrome reported through the same file:// path the rendezvous will use. */
async function readBack(absolutePath: string) {
  try {
    const url = fileUrlFor(absolutePath);
    const response = await fetch(url);
    return { ok: true, url, text: await response.text() };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

// Experiments drive the real extension path through these, never chrome.downloads directly.
const poc = {
  probe: (namespace: string, content: string, options: ProbeOptions = {}) =>
    browser.runtime.sendMessage({ type: "POC_DOWNLOAD_PROBE", namespace, content, ...options }),
  cancel: (id: number) => browser.runtime.sendMessage({ type: "POC_DOWNLOAD_CANCEL", id }),
  search: (id?: number) =>
    browser.runtime.sendMessage({
      type: "POC_DOWNLOAD_SEARCH",
      ...(id === undefined ? {} : { id }),
    }),
  readBack,
  /** The tolerant reader over a file:// read; a failed read counts as a temporary error. */
  readPublication: async (absolutePath: string, previous: Presence | undefined) => {
    const read = await readBack(absolutePath);
    return readTolerant(read.ok ? read.text : undefined, previous);
  },
};
Object.assign(window, { __poc: poc });
installReadFile(window);

const permissions = browser.runtime.getManifest().permissions ?? [];

const report = {
  extensionId: browser.runtime.id,
  mode: import.meta.env.MODE,
  permissions,
  fileSchemeAccess: await browser.extension.isAllowedFileSchemeAccess(),
  incognitoAccess: await browser.extension.isAllowedIncognitoAccess(),
  debuggerDeclared: permissions.includes("debugger"),
};

const target = document.getElementById("diagnostics");
if (target) target.textContent = JSON.stringify(report, null, 2);
