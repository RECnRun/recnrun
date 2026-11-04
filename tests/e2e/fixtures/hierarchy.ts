import { profileIdOf } from "./profiles.ts";
import type { Profile } from "./profiles.ts";

interface StorageGlobal {
  chrome: {
    storage: {
      local: {
        get(key: string): Promise<Record<string, unknown>>;
        set(items: Record<string, unknown>): Promise<void>;
      };
    };
  };
}

/** The certificate `profile` pinned for `peer` when their link was first verified. */
const pinOf = (profile: Profile, peer: string): Promise<string> =>
  profile.serviceWorker.evaluate(async (id) => {
    const { chrome } = globalThis as unknown as StorageGlobal;
    const { peerPins } = await chrome.storage.local.get("peerPins");
    const pin = (peerPins as Record<string, { fingerprint: string }> | undefined)?.[id];
    if (!pin) throw new Error(`No pin for ${id}.`);
    return pin.fingerprint;
  }, peer);

const store = (profile: Profile, items: Record<string, unknown>) =>
  profile.serviceWorker.evaluate(
    (values) => (globalThis as unknown as StorageGlobal).chrome.storage.local.set(values),
    items,
  );

/**
 * Binds `workers` to `master` as the local channel does once each pair is linked: the FSA flow has
 * no launcher, so the test writes, from the certificates each side pinned at pairing, each
 * worker's binding, then the master's workers and its own record.
 */
export async function bindHierarchy(master: Profile, workers: Profile[]): Promise<void> {
  const masterId = await profileIdOf(master);
  const boundAt = Date.now();
  const boundWorkers: Record<string, unknown> = {};
  let fingerprint = "";
  for (const worker of workers) {
    const workerId = await profileIdOf(worker);
    fingerprint = await pinOf(worker, masterId);
    const binding = { masterProfileId: masterId, masterFingerprint: fingerprint, boundAt };
    await store(worker, { role: { role: "worker", ...binding, source: "pairing" } });
    const pinned = await pinOf(master, workerId);
    boundWorkers[workerId] = { fingerprint: pinned, boundAt, source: "pairing" };
  }
  // The workers go first, so the master never refuses a report of its own workers.
  await store(master, { boundWorkers });
  await store(master, { role: { role: "master", profileId: masterId, fingerprint } });
}
