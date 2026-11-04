import { vi } from "vite-plus/test";
import { createFolderPairing } from "@/background/folder-pairing";
import type { LinkCommand } from "@/messaging/peer-messages";
import { PAIRING_TTL_MS } from "@/p2p/pairing-code";
import { createPins } from "@/p2p/pins";
import type { Pin } from "@/p2p/pins";
import type { AnsweredOffer } from "@/storage/answered-repository";
import type { FolderActed, FolderPairing, PeerLink, PendingOffer } from "@/storage/peer-repository";
import { ME, PEER, memoryRecords, memoryRepository } from "./fake-peer";
import { NOW, OFFER_ID, signal } from "./folder-sightings";

/** The background's folder pairing over fakes, as profile `me`, whose link is idle. */
export function folderPairing(
  initial: FolderPairing | null = {},
  me = ME,
  initialActed: Record<string, FolderActed> = {},
) {
  const commands: LinkCommand[] = [];
  const askLink = vi.fn(async (command: LinkCommand) => void commands.push(command));
  const pending = memoryRecords<PendingOffer>();
  const offer = signal("offer", me, PEER);
  const answer = signal("answer", me, PEER);
  const pairing = {
    createOffer: vi.fn(async (to: string) => {
      await pending.set(to, {
        pairingId: OFFER_ID,
        expiresAt: NOW + PAIRING_TTL_MS,
        to,
        code: offer.code,
      });
      return { code: offer.code };
    }),
    accept: vi.fn(async (_code: string): Promise<{ code?: string }> => ({ code: answer.code })),
  };
  const state = memoryRepository<FolderPairing>(initial);
  const acted = memoryRecords<FolderActed>(initialActed);
  const answered = memoryRecords<AnsweredOffer>();
  const link = memoryRecords<PeerLink>();
  const log = vi.fn();
  const pinned = memoryRecords<Pin>();
  const flow = createFolderPairing({
    askLink,
    identity: async () => ({ profileId: me, displayName: "Laptop" }),
    pairing,
    pending,
    link,
    acted,
    answered,
    state,
    pins: createPins(pinned),
    log,
    now: () => NOW,
  });
  const fakes = { askLink, commands, pairing, state, acted, answered, link, pending, pinned, log };
  return { flow, ...fakes, offer, answer };
}
