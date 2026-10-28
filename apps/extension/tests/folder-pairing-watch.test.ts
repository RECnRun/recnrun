import { expect, test, vi } from "vite-plus/test";
import { createFolderPairing } from "@/background/folder-pairing";
import type { Presence } from "@/p2p/folder-rendezvous";
import type { FolderPairing } from "@/storage/peer-repository";
import { ME, PEER, STRANGER, memoryRecords, memoryRepository } from "./fake-peer";

const at = (profileId: string): Presence => ({
  profileId,
  displayName: "Profile",
  fingerprint: "22:22",
  createdAt: 1,
  expiresAt: Date.now() + 60_000,
});

/** Folder pairing as ME, waiting unless `state` is null, whose steps all fail. */
function watching(state: FolderPairing | null = {}) {
  const askLink = vi.fn(async (_command: unknown): Promise<unknown> => undefined);
  const failing = vi.fn(async (_code: string): Promise<{ code: string }> => {
    throw new Error("No link here.");
  });
  const log = vi.fn();
  const flow = createFolderPairing({
    askLink,
    identity: async () => ({ profileId: ME, displayName: "Laptop" }),
    pairing: { createOffer: failing, accept: failing },
    pending: memoryRecords(),
    link: memoryRecords(),
    acted: memoryRecords(),
    state: memoryRepository(state),
    log,
  });
  return { flow, failing, log, askLink };
}

test("logs a step that fails, and handles the next sighting", async () => {
  const { flow, failing, log } = watching();
  await flow.seen({ presences: [at(PEER)], signals: [] });
  expect(log).toHaveBeenCalledWith("folder pairing: No link here.");
  await flow.seen({ presences: [at(PEER)], signals: [] });
  expect(failing).toHaveBeenCalledTimes(2);
});

test("Reconnect unpauses even while Chrome holds the folder back, and logs the look it missed", async () => {
  const { flow, askLink, log } = watching({ paused: [PEER, STRANGER] });
  askLink.mockRejectedValue(new Error("Choose the RECnRun folder first."));
  await flow.unpause(PEER);
  await flow.unpauseAll();
  expect(await flow.paused()).toEqual([]);
  expect(log).toHaveBeenCalledWith("folder pairing: Choose the RECnRun folder first.");
});
