import { describe, expect, test } from "vite-plus/test";
import { MAX_FRAME_LENGTH, parsePeerFrame, peerMessage } from "@/p2p/protocol";

const route = {
  from: "11111111-1111-4111-8111-111111111111",
  to: "22222222-2222-4222-8222-222222222222",
};

const tab = {
  id: 3,
  windowId: 1,
  incognito: false as const,
  title: "Shop",
  url: "https://shop.test/",
};

const frameOf = (value: unknown) => JSON.stringify(value);

describe("peerMessage", () => {
  test("builds an envelope with a fresh id that parses back unchanged", () => {
    const first = peerMessage("ACTIVATE_TAB", route, { tabId: 42 });
    const second = peerMessage("ACTIVATE_TAB", route, { tabId: 42 });
    expect(first).toMatchObject({
      channel: "recnrun-peer",
      protocol: 1,
      ...route,
      type: "ACTIVATE_TAB",
      tabId: 42,
    });
    expect(first.id).not.toBe(second.id);
    expect(parsePeerFrame(frameOf(first))).toEqual(first);
  });

  test("carries replies and tab snapshots", () => {
    const ask = peerMessage("GET_TABS", route, {});
    const snapshot = peerMessage("TABS_SNAPSHOT", route, {
      requestId: ask.id,
      tabs: [tab],
      currentId: 3,
    });
    expect(parsePeerFrame(frameOf(snapshot))).toEqual(snapshot);
    const status = peerMessage("SESSION_STATUS", route, {
      session: { tabId: 3, status: "recording", banked: 0, since: 1_000 },
      controlledBy: null,
    });
    expect(parsePeerFrame(frameOf(status))).toEqual(status);
  });

  test("says goodbye with no payload", () => {
    const bye = peerMessage("BYE", route, {});
    expect(parsePeerFrame(frameOf(bye))).toEqual(bye);
  });
});

describe("parsePeerFrame", () => {
  const valid = () => peerMessage("GET_TABS", route, {});

  test.each([
    ["a wrong channel", { channel: "other" }],
    ["another protocol version", { protocol: 2 }],
    ["an unknown type", { type: "SELF_DESTRUCT" }],
    ["an extra field", { extra: true }],
    ["a sender that is not a profile id", { from: "profile-a" }],
    ["a message id that is not a uuid", { id: "1" }],
  ])("drops a frame with %s", (_, change) => {
    expect(parsePeerFrame(frameOf({ ...valid(), ...change }))).toBeUndefined();
  });

  test("drops an incognito or favicon-carrying tab", () => {
    for (const shared of [
      { ...tab, incognito: true },
      { ...tab, favIconUrl: "x" },
    ]) {
      const changed = { ...valid(), type: "TABS_CHANGED", tabs: [shared] };
      expect(parsePeerFrame(frameOf(changed))).toBeUndefined();
    }
  });

  test("drops a frame that is not JSON", () => {
    expect(parsePeerFrame("{not json")).toBeUndefined();
  });

  test("drops an oversized frame without parsing it", () => {
    const hello = peerMessage("HELLO", route, { displayName: "A", extensionVersion: "1" });
    const padded = frameOf(hello).padEnd(MAX_FRAME_LENGTH + 1, " ");
    expect(parsePeerFrame(padded)).toBeUndefined();
    expect(parsePeerFrame(padded.slice(0, MAX_FRAME_LENGTH))).toEqual(hello);
  });
});
