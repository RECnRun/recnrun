import { vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { startPeers } from "@/background/peers";
import type { PeerMessage } from "@/p2p/protocol";
import { storedRoles } from "@/storage/hierarchy-repository";
import { authorizedPeersRepository, identityRepository } from "@/storage/peer-repository";
import { FINGERPRINT, ME, PEER, fakeOffscreen } from "./fake-peer";

const manifest = { manifest_version: 3 as const, name: "RECnRun", version: "0.1.0" };

/** Every frame the test build kept, both ways. */
export const tappedFrames = (): string[] =>
  (globalThis as { recnrunPeerFrames?: string[] }).recnrunPeerFrames ?? [];

/** Binds this profile to PEER as its master, as the local channel would once the pair is linked. */
export const bindToPeer = () =>
  storedRoles().bind({ profileId: PEER, fingerprint: FINGERPRINT, source: "pairing" });

/**
 * The background's peer half over the fake browser and offscreen document, with this profile's
 * identity stored and, unless told otherwise, the peer authorized with FINGERPRINT.
 */
export async function peerBackground({ authorized = true } = {}) {
  vi.spyOn(fakeBrowser.runtime, "getManifest").mockReturnValue(manifest);
  // The fake browser has no tabs.onMoved or tabs.onAttached; these stand in for them.
  const moved: (() => void)[] = [];
  for (const event of ["onMoved", "onAttached"] as const)
    vi.spyOn(fakeBrowser.tabs[event], "addListener").mockImplementation((...args: unknown[]) => {
      moved.push(args[0] as () => void);
    });
  const log = vi.spyOn(console, "debug").mockImplementation(() => {});
  const link = fakeOffscreen();
  tappedFrames().length = 0;
  await identityRepository.write({ profileId: ME, displayName: "Laptop" });
  if (authorized)
    await authorizedPeersRepository.set(PEER, {
      profileId: PEER,
      displayName: "Desk",
      fingerprint: FINGERPRINT,
    });
  const routes = startPeers();
  // Null stands for a link that reported no certificate.
  const connect = (remoteFingerprint: string | null = FINGERPRINT, peer = PEER) =>
    routes.link({
      type: "state",
      peer,
      state: "connected",
      remoteFingerprint: remoteFingerprint ?? undefined,
    });
  /** A frame that came over the link to `peer`. */
  const receive = (message: PeerMessage | string, peer = PEER) =>
    routes.link({
      type: "frame",
      peer,
      frame: typeof message === "string" ? message : JSON.stringify(message),
    });
  return { routes, link, connect, receive, moved, log };
}
