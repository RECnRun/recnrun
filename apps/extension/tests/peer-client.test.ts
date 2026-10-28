import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { peerNotice } from "@/messaging/peer-messages";
import { peerServices } from "@/peers/page-services";
import { remoteRecordingRepository } from "@/storage/peer-repository";
import { createPeerClient } from "@/views/peer-client";
import { PEER, answering } from "./fake-peer";

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
    await expect(createPeerClient().ask({ type: "ping" }, v.unknown())).rejects.toThrow(
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
  test("reads the peer's tabs from the background", async () => {
    const tabs = {
      tabs: [{ id: 1, windowId: 2, incognito: false, title: "A", url: "https://a/" }],
    };
    const sent = background({ ok: true, result: tabs });
    expect(await peerServices().tabs.read()).toEqual(tabs);
    expect(sent).toEqual([{ type: "peer", request: { type: "tabs" } }]);
  });

  test("reads the session it controls from session storage and commands the peer to change it", async () => {
    const sent = background({ ok: true });
    const { recordings } = peerServices();
    const onChange = vi.fn();
    const unwatch = recordings.watch(onChange);
    expect(await recordings.read()).toBeNull();
    await remoteRecordingRepository.write({
      profileId: PEER,
      session,
      mine: true,
      connected: true,
    });
    expect(await recordings.read()).toEqual(session);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    unwatch();
    await recordings.write({ ...session, status: "recording" });
    expect(sent).toEqual([{ type: "peer", request: { type: "session-set", status: "recording" } }]);
  });

  test("opens the folder page in a small window of its own", async () => {
    const create = vi.spyOn(fakeBrowser.windows, "create");
    await peerServices().openFolder();
    expect(create).toHaveBeenCalledWith({
      url: fakeBrowser.runtime.getURL("/pairing.html#folder"),
      type: "popup",
      width: 480,
      height: 360,
    });
  });

  test("opens the pairing page in a new tab", async () => {
    const create = vi.spyOn(fakeBrowser.tabs, "create");
    await peerServices().openPairing();
    expect(create).toHaveBeenCalledWith({ url: fakeBrowser.runtime.getURL("/pairing.html") });
  });
});
