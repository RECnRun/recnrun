import * as v from "valibot";
import { vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { PresenceSchema } from "@/p2p/folder-rendezvous";
import { identityRepository } from "@/storage/peer-repository";
import { ME, answering, fakeOffscreen } from "./fake-peer";

export const ROOT = "/home/me/Downloads";
const manifest = { manifest_version: 3 as const, name: "RECnRun", version: "0.1.0" };
const RegistrationSchema = v.strictObject({
  ...PresenceSchema.entries,
  namespace: v.string(),
  boot: v.string(),
});

/** chrome.downloads over the fake browser: each write lands under ROOT and completes at once. */
function fakeDownloads() {
  const written: { url: string; filename: string; saveAs: boolean; conflictAction: string }[] = [];
  vi.spyOn(fakeBrowser.downloads, "download").mockImplementation(
    answering((options) => written.push(options as (typeof written)[number])),
  );
  vi.spyOn(fakeBrowser.downloads, "search").mockImplementation(
    answering((query) => {
      const { id = 0 } = query as { id?: number };
      const options = written[id - 1];
      return options ? [{ id, filename: `${ROOT}/${options.filename}`, state: "complete" }] : [];
    }),
  );
  // The fake browser has no downloads.onChanged; every item here has settled already.
  for (const method of ["addListener", "removeListener"] as const)
    vi.spyOn(fakeBrowser.downloads.onChanged, method).mockImplementation(() => {});
  return written;
}

/** The fake browser with this profile's identity, the offscreen document, and Downloads. */
export async function background() {
  vi.spyOn(fakeBrowser.runtime, "getManifest").mockReturnValue(manifest);
  vi.spyOn(console, "debug").mockImplementation(() => {});
  for (const event of ["onMoved", "onAttached"] as const)
    vi.spyOn(fakeBrowser.tabs[event], "addListener").mockImplementation(() => {});
  await identityRepository.write({ profileId: ME, displayName: "Laptop" });
  return { link: fakeOffscreen(), written: fakeDownloads(), log: vi.mocked(console.debug) };
}

export const registrationOf = (url: string) =>
  v.parse(RegistrationSchema, JSON.parse(contentOf(url)));
export const contentOf = (url: string) => decodeURIComponent(url.slice(url.indexOf(",") + 1));
// The first presence signs with a key made in fake IndexedDB; under a Docker run that outlasts 1 s.
export const settles = (check: () => unknown) => vi.waitFor(check, { timeout: 5_000 });
