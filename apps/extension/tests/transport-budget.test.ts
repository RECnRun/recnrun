import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { COMMAND_TYPES, MESSAGE_CLASSES } from "@/p2p/authorization";
import { parsePeerFrame, peerTypes } from "@/p2p/protocol";
import type { PeerPayload, PeerType } from "@/p2p/protocol";
import type { PeerRequest } from "@/messaging/peer-messages";
import { recordingSessionRepository } from "@/storage/recording-session-repository";
import { memoryRecordingStore } from "./fake-extension";
import { ME, PEER, PEER_HELLO, answering, fromPeer } from "./fake-peer";
import { bindToPeer, peerBackground, tappedFrames } from "./peer-background";

const REQUEST = "99999999-9999-4999-8999-999999999999";
const SESSION = { tabId: 0, status: "recording" as const, banked: 0, since: 1 };
const PAYLOADS = {
  ACTIVATE_TAB: { tabId: 0 },
  SESSION_START: { tabId: 0 },
  SESSION_SET_STATUS: { status: "paused" },
  SESSION_STOP: {},
  HELLO: PEER_HELLO,
  GET_TABS: {},
  TABS_CHANGED: { tabs: [] },
  SESSION_STATUS: { session: SESSION, controlledBy: ME },
  TABS_SNAPSHOT: { requestId: REQUEST, tabs: [] },
  COMMAND_RESULT: { requestId: REQUEST, ok: true },
  ERROR: { requestId: REQUEST, reason: "Refused." },
} satisfies Partial<{ [T in PeerType]: PeerPayload<T> }>;

beforeEach(() => {
  fakeBrowser.reset();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("every command, result, and status type has a transport budget case", () => {
  const business = peerTypes().filter((type) =>
    ["command", "result", "status"].includes(MESSAGE_CLASSES[type]),
  );
  expect(Object.keys(PAYLOADS).sort()).toEqual(business.sort());
  expect([...COMMAND_TYPES].every((type) => type in PAYLOADS)).toBe(true);
});

async function paired() {
  const download = vi
    .spyOn(fakeBrowser.downloads, "download")
    .mockImplementation(answering(() => 1));
  const path = `/tmp/Downloads/RECnRun/poc/lab/peers/${ME}/presence.json`;
  vi.spyOn(fakeBrowser.downloads, "search").mockImplementation(
    answering(() => [{ id: 1, filename: path, state: "complete" }]),
  );
  for (const method of ["addListener", "removeListener"] as const)
    vi.spyOn(fakeBrowser.downloads.onChanged, method).mockImplementation(() => {});
  const peers = await peerBackground({ transport: "downloads" });
  await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(1));
  await peers.connect();
  await bindToPeer();
  return { ...peers, download };
}

test.each(Object.entries(PAYLOADS))(
  "%s uses the paired DataChannel without a download",
  async (type, payload) => {
    const peers = await paired();
    const { download } = peers;
    const tab = await fakeBrowser.tabs.create({ url: "https://example.test/" });
    const store = memoryRecordingStore(SESSION);
    await recordingSessionRepository.write(await store.read());
    const frame = fromPeer(type as keyof typeof PAYLOADS, {
      ...payload,
      ...("tabId" in payload && { tabId: tab.id ?? 0 }),
    });
    expect(parsePeerFrame(JSON.stringify(frame))).toEqual(frame);
    const before = download.mock.calls.length;
    await peers.receive(frame);
    await vi.advanceTimersByTimeAsync(200);
    expect(tappedFrames()).toContain(JSON.stringify(frame));
    expect(peers.log.mock.calls.flat().join(" ")).toContain(`received ${type}`);
    expect(download.mock.calls.length - before, `${type} must never write a rendezvous item`).toBe(
      0,
    );
    expect(peers.link.commands.filter((command) => command.type === "send").length).toBeGreaterThan(
      0,
    );
    expect(await fakeBrowser.alarms.get("poc-presence")).toBeDefined();
    await fakeBrowser.alarms.clearAll();
  },
);

const REQUESTS = [
  { type: "activate", peer: PEER, tabId: 0 },
  { type: "session-start", peer: PEER, tabId: 0 },
  { type: "session-set", peer: PEER, status: "paused" },
  { type: "session-stop", peer: PEER },
] as const satisfies readonly PeerRequest[];

test.each(REQUESTS)("outgoing $type uses the DataChannel without a download", async (request) => {
  const peers = await paired();
  const before = peers.download.mock.calls.length;
  const pending = peers.routes.request(request);
  await vi.waitFor(() =>
    expect(peers.link.frames().some((frame) => COMMAND_TYPES.has(frame.type))).toBe(true),
  );
  const frame = peers.link.frames().find((sent) => COMMAND_TYPES.has(sent.type)) as unknown as {
    id: string;
    type: PeerType;
  };
  expect(COMMAND_TYPES.has(frame.type)).toBe(true);
  await peers.receive(fromPeer("COMMAND_RESULT", { requestId: frame.id, ok: true }));
  await pending;
  await vi.advanceTimersByTimeAsync(200);
  expect(peers.download.mock.calls.length - before).toBe(0);
  await fakeBrowser.alarms.clearAll();
});
