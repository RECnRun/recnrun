import { vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import type { LinkCommand } from "@/messaging/peer-messages";
import { peerMessage } from "@/p2p/protocol";
import type { MessageOf, PeerPayload, PeerType } from "@/p2p/protocol";

/** A spy's stand-in for an overloaded browser API, whose spy takes the callback overload's type. */
export const answering =
  (answer: (message: unknown) => unknown) =>
  (message: unknown): never =>
    new Promise((resolve) => resolve(answer(message))) as never;

export const ME = "11111111-1111-4111-8111-111111111111";
export const PEER = "22222222-2222-4222-8222-222222222222";
export const STRANGER = "33333333-3333-4333-8333-333333333333";
export const FINGERPRINT = "AB:CD:EF";

/** A message the peer addressed to this profile. */
export const fromPeer = <T extends PeerType>(type: T, payload: PeerPayload<T>, from = PEER) =>
  peerMessage(type, { from, to: ME }, payload);

/** A stored value with read and write, as a repository keeps it. */
export function memoryRepository<T>(initial: T | null = null) {
  let value = initial;
  return {
    read: vi.fn(async () => value),
    write: vi.fn(async (next: T | null) => {
      value = next;
    }),
  };
}

/** A channel whose sends are recorded, so a test reads what went to the peer. */
export function recordingChannel() {
  const sent: { type: PeerType; payload: unknown }[] = [];
  const send = async <T extends PeerType>(type: T, payload: PeerPayload<T>) => {
    sent.push({ type, payload });
    return peerMessage(type, { from: ME, to: PEER }, payload) as MessageOf<T>;
  };
  return { channel: { send }, sent };
}

/**
 * The offscreen document as the background sees it: already open, answering every command, with
 * each command and each page notice recorded.
 */
export function fakeOffscreen() {
  const commands: LinkCommand[] = [];
  const notices: unknown[] = [];
  // `pagesOpen: false` rejects notices, as Chrome does when no page listens.
  const link = { sent: true, pagesOpen: true };
  vi.spyOn(fakeBrowser.runtime, "getContexts").mockImplementation(answering(() => []));
  vi.spyOn(fakeBrowser.offscreen, "createDocument").mockResolvedValue(undefined);
  const answer = (message: unknown) => {
    const { target, command } = message as { target?: string; command: LinkCommand };
    if (target !== "offscreen") {
      if (!link.pagesOpen) throw new Error("Receiving end does not exist.");
      return void notices.push(message);
    }
    commands.push(command);
    return { ok: true, result: command.type === "send" ? { sent: link.sent } : undefined };
  };
  vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation(answering(answer));
  const frames = () =>
    commands.flatMap((command) =>
      command.type === "send" ? [JSON.parse(command.frame) as { type: PeerType }] : [],
    );
  return { commands, notices, link, frames, sentTypes: () => frames().map((each) => each.type) };
}
