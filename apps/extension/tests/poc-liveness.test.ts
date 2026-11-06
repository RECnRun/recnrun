import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { linkCommandMessage } from "@/messaging/peer-messages";
import { startPocLiveness } from "@/offscreen/poc-liveness";
import { startOffscreen } from "@/offscreen/start";
import { FakeConnection, certificate } from "./fake-connection";
import { PEER, STRANGER, answering } from "./fake-peer";

const background = {
  id: fakeBrowser.runtime.id,
  url: fakeBrowser.runtime.getURL("/background.js"),
};
const page = { id: fakeBrowser.runtime.id, url: fakeBrowser.runtime.getURL("/dashboard.html") };

/** Delivers one message; resolves with the reply, or "ignored" when no listener took it. */
async function ask(message: unknown, sender: { id: string; url: string } = background) {
  const replies: unknown[] = [];
  const handled: unknown[] = await fakeBrowser.runtime.onMessage.trigger(
    message,
    sender,
    (reply: unknown) => replies.push(reply),
  );
  if (!handled.includes(true)) return "ignored";
  await vi.waitFor(() => expect(replies).toHaveLength(1), { interval: 1 });
  return replies[0];
}

beforeEach(() => {
  fakeBrowser.reset();
  FakeConnection.made = [];
  vi.stubGlobal("RTCPeerConnection", FakeConnection);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("startPocLiveness", () => {
  test("answers the background with what each link heard and beat", async () => {
    startPocLiveness(async () => ({ [PEER]: { heardAt: 5, beats: 2 } }));
    expect(await ask({ type: "POC_LIVENESS" })).toEqual({
      ok: true,
      result: { peers: { [PEER]: { heardAt: 5, beats: 2 } } },
    });
  });

  test("answers no page and no other message", async () => {
    const liveness = vi.fn(async () => ({}));
    startPocLiveness(liveness);
    expect(await ask({ type: "POC_LIVENESS" }, page)).toBe("ignored");
    expect(await ask({ type: "POC_LIVENESS", extra: 1 })).toBe("ignored");
    expect(liveness).not.toHaveBeenCalled();
  });

  test("reports a liveness that cannot be read as an error", async () => {
    startPocLiveness(() => Promise.reject(new Error("No certificate.")));
    expect(await ask({ type: "POC_LIVENESS" })).toEqual({ ok: false, error: "No certificate." });
  });
});

describe("the offscreen document's liveness", () => {
  test("names each link's peer, when its channel last delivered anything, and the beats it sent", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation(answering(() => undefined));
    const offscreen = startOffscreen({ certificate: async () => certificate });
    startPocLiveness(offscreen.liveness);
    await ask(linkCommandMessage({ type: "offer", peer: PEER }));
    await ask(linkCommandMessage({ type: "offer", peer: STRANGER }));
    const [linked] = FakeConnection.made;
    linked?.channel?.open();
    const beat = () =>
      linked?.channel?.dispatchEvent(new MessageEvent("message", { data: new Uint8Array([0]) }));
    vi.advanceTimersByTime(1_000);
    beat();
    vi.advanceTimersByTime(1_000);
    beat();
    const heardAt = Date.now();
    vi.advanceTimersByTime(1_000);
    expect(await ask({ type: "POC_LIVENESS" })).toEqual({
      ok: true,
      result: { peers: { [PEER]: { heardAt, beats: 3 }, [STRANGER]: { beats: 0 } } },
    });
  });
});
