import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";

/**
 * The worker's side of the binding, which the local channel writes in the product: the master's
 * pin and its record, written while the installer is still attached. The master's side follows the
 * first link (bindMaster); no client is on the worker once the launcher opens it.
 */
export async function bindWorker(extension: LoadedExtension, presence: Record<string, unknown>) {
  const { key } = presence.identity as { key: string };
  const master = String(presence.profileId);
  const now = Date.now();
  const items = {
    peerPins: {
      [master]: {
        fingerprint: presence.fingerprint,
        identity: key,
        pinnedAt: now,
        source: "local-channel",
      },
    },
    role: {
      role: "worker",
      masterProfileId: master,
      masterIdentity: key,
      boundAt: now,
      source: "pairing",
    },
  };
  await extension.evaluateInBackground(`chrome.storage.local.set(${JSON.stringify(items)})`);
}
