import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { peerNotice } from "@/messaging/peer-messages";
import { allowFolder, chooseFolder } from "@/p2p/folder-store";
import { createPins } from "@/p2p/pins";
import { peerServices } from "@/peers/page-services";
import { roleStores } from "@/storage/hierarchy-repository";
import {
  identityRepository,
  peerPinsRepository,
  remoteRecordingsRepository,
} from "@/storage/peer-repository";
import { createPeerClient } from "@/views/peer-client";
import { FINGERPRINT, ME, PEER, PEER_IDENTITY, STRANGER, answering } from "./fake-peer";
import { identityOf } from "./test-identity";

const binding = { role: "worker", boundAt: 1, source: "pairing" } as const;

const NamedSchema = v.strictObject({ name: v.string() });
const session = { tabId: 4, status: "paused" as const, banked: 10, since: 1 };

/** The background answering every runtime message with `reply`, each message recorded. */
function background(reply: unknown) {
  const sent: unknown[] = [];
  vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation(
    answering((message) => {
      sent.push(message);
      return reply;
    }),
  );
  return sent;
}

/** A runtime message to every page's listeners, which run at once. */
const notify = (message: unknown) =>
  void fakeBrowser.runtime.onMessage.trigger(message, {}, () => {});

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ask", () => {
  test("sends the request to the background and returns the validated result", async () => {
    const sent = background({ ok: true, result: { name: "Bob" } });
    const client = createPeerClient();
    expect(await client.ask({ type: "rename", displayName: "Bob" }, NamedSchema)).toEqual({
      name: "Bob",
    });
    expect(sent).toEqual([{ type: "peer", request: { type: "rename", displayName: "Bob" } }]);
  });

  test("throws the background's error", async () => {
    background({ ok: false, error: "No peer is paired." });
    await expect(createPeerClient().ask({ type: "status" }, v.unknown())).rejects.toThrow(
      "No peer is paired.",
    );
  });

  test.each([
    ["a reply of another shape", { done: true }],
    ["a result the request does not expect", { ok: true, result: { name: 7 } }],
    ["no reply", undefined],
  ])("refuses %s", async (_, reply) => {
    background(reply);
    await expect(createPeerClient().ask({ type: "status" }, NamedSchema)).rejects.toThrow(
      v.ValiError,
    );
  });
});

describe("watch", () => {
  test("calls back on a peer notice only, until unwatched", async () => {
    const onChange = vi.fn();
    const unwatch = createPeerClient().watch(onChange);
    notify({ type: "peer-changed" });
    notify({ target: "offscreen", command: {} });
    expect(onChange).not.toHaveBeenCalled();
    notify(peerNotice());
    expect(onChange).toHaveBeenCalledOnce();
    unwatch();
    notify(peerNotice());
    expect(onChange).toHaveBeenCalledOnce();
  });
});

describe("peerServices", () => {
  test("reads a peer's tabs from the background", async () => {
    const tabs = {
      tabs: [{ id: 1, windowId: 2, incognito: false, title: "A", url: "https://a/" }],
    };
    const sent = background({ ok: true, result: tabs });
    expect(await peerServices().tabsOf(PEER).read()).toEqual(tabs);
    expect(sent).toEqual([{ type: "peer", request: { type: "tabs", peer: PEER } }]);
  });

  test("reads the session it controls from session storage and commands the peer to change it", async () => {
    const sent = background({ ok: true });
    const { recordings, sessionTabs } = peerServices();
    const onChange = vi.fn();
    const unwatch = recordings.watch(onChange);
    expect(await recordings.read()).toBeNull();
    expect(await sessionTabs.read()).toEqual({ tabs: [] });
    await remoteRecordingsRepository.set(PEER, {
      profileId: PEER,
      session,
      mine: true,
      connected: true,
    });
    expect(await recordings.read()).toEqual(session);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    unwatch();
    await recordings.write({ ...session, status: "recording" });
    expect(sent).toEqual([
      { type: "peer", request: { type: "session-set", peer: PEER, status: "recording" } },
    ]);
  });

  test("reads the session it controls under the peer that runs it, and none under another", async () => {
    background({ ok: true });
    const services = peerServices();
    const report = { profileId: STRANGER, session, mine: true, connected: true };
    await remoteRecordingsRepository.set(STRANGER, report);
    expect(await services.recordingsOf(STRANGER).read()).toEqual(session);
    expect(await services.recordingsOf(PEER).read()).toBeNull();
    expect(await services.recordings.read()).toEqual(session);
  });

  test("controls another profile only as the master of its bound worker, hearing each change", async () => {
    const services = peerServices();
    let changes = 0;
    const stop = services.watchControl(() => changes++);
    // Before it has an identity, a profile knows of no one it controls, itself included.
    expect(await services.mayControl(ME)).toBe(false);
    await identityRepository.write({ profileId: ME, displayName: "Alice" });
    const proven = { identity: PEER_IDENTITY, fingerprint: FINGERPRINT };
    await createPins(peerPinsRepository).pin(PEER, proven, "pairing-code");
    const { role, workers } = roleStores();
    await role.write({ ...binding, masterProfileId: PEER, masterIdentity: PEER_IDENTITY });
    expect(await services.mayControl(ME)).toBe(true);
    expect(await services.mayControl(PEER)).toBe(false);
    await role.write({ role: "master", profileId: ME, identity: await identityOf(ME) });
    await workers.set(PEER, { identity: PEER_IDENTITY, boundAt: 1, source: "pairing" });
    expect(await services.mayControl(PEER)).toBe(true);
    expect(await services.mayControl(STRANGER)).toBe(false);
    await expect.poll(() => changes).toBe(5);
    stop();
    await role.write(null);
    expect(changes).toBe(5);
  });

  test("asks for the folder in the dashboard itself, through the folder store", () => {
    const services = peerServices();
    expect(services.chooseFolder).toBe(chooseFolder);
    expect(services.allowFolder).toBe(allowFolder);
  });
});
