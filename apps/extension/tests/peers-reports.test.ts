import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  authorizedPeersRepository,
  remoteControllerRepository,
  remoteRecordingsRepository,
} from "@/storage/peer-repository";
import { recordingSessionRepository } from "@/storage/recording-session-repository";
import { ME, PEER, STRANGER, fromPeer } from "./fake-peer";
import { peerBackground } from "./peer-background";

const session = { tabId: 4, status: "recording" as const, banked: 0, since: 1 };
const TAB = { id: 3, windowId: 1, incognito: false as const, title: "Shop", url: "https://s/" };

/** A normal window with a tab that has a favicon, and an incognito window, as Chrome lists them. */
const WINDOWS = [
  {
    id: 1,
    focused: true,
    alwaysOnTop: false,
    incognito: false,
    tabs: [
      { ...TAB, id: 5, active: true, favIconUrl: "https://s/favicon.ico" },
      { ...TAB, id: 6, windowId: 1, active: false },
    ],
  },
  {
    id: 2,
    focused: false,
    alwaysOnTop: false,
    incognito: true,
    tabs: [{ ...TAB, id: 9, windowId: 2, incognito: true, active: true, title: "Private" }],
  },
];

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("this profile's tabs", () => {
  test("go to the peer once per burst of events, never incognito, never with favicons", async () => {
    const peers = await peerBackground();
    await peers.connect();
    vi.spyOn(fakeBrowser.windows, "getAll").mockResolvedValue(WINDOWS as never);
    vi.useFakeTimers();
    await fakeBrowser.tabs.create({ url: "https://docs.example/" });
    await fakeBrowser.windows.onFocusChanged.trigger(2);
    for (const listener of peers.moved) listener();
    await vi.advanceTimersByTimeAsync(149);
    expect(peers.link.sentTypes()).toEqual(["HELLO"]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(peers.link.sentTypes()).toEqual(["HELLO", "TABS_CHANGED"]));
    const { tabs, currentId } = peers.link.frames()[1] as unknown as Record<string, unknown>;
    expect(tabs).toEqual([
      { ...TAB, id: 5 },
      { ...TAB, id: 6 },
    ]);
    expect(currentId).toBe(5);
  });

  test("are not reported without a verified link", async () => {
    const peers = await peerBackground();
    vi.useFakeTimers();
    await fakeBrowser.tabs.remove(0);
    await vi.advanceTimersByTimeAsync(150);
    await vi.waitFor(() => expect(peers.link.commands).toEqual([]));
    expect(peers.log).not.toHaveBeenCalled();
  });

  test("a report that could not go out is logged", async () => {
    const peers = await peerBackground();
    await peers.connect();
    peers.link.link.sent = false;
    vi.useFakeTimers();
    await fakeBrowser.windows.onRemoved.trigger(2);
    await vi.advanceTimersByTimeAsync(150);
    await vi.waitFor(() =>
      expect(peers.log).toHaveBeenCalledWith(
        "[RECnRun peer]",
        "The other profile is not connected.",
      ),
    );
  });
});

describe("unreadable state", () => {
  test("an unreadable link or session sends nothing, and closed pages break nothing", async () => {
    const peers = await peerBackground();
    await peers.connect();
    peers.link.link.pagesOpen = false;
    await peers.receive(fromPeer("TABS_CHANGED", { tabs: [] }));
    await fakeBrowser.storage.session.set({ peerLinks: "unreadable" });
    vi.useFakeTimers();
    await fakeBrowser.tabs.update(0, { url: "https://docs.example/" });
    await vi.advanceTimersByTimeAsync(150);
    await fakeBrowser.storage.session.set({ recording: "unreadable" });
    await vi.advanceTimersByTimeAsync(10);
    expect(peers.link.sentTypes()).toEqual(["HELLO"]);
  });
});

describe("this profile's session", () => {
  test("goes to the verified peer on every change, naming no controller for a local one", async () => {
    const peers = await peerBackground();
    await peers.connect();
    await recordingSessionRepository.write(session);
    await vi.waitFor(() =>
      expect(peers.link.frames().at(-1)).toMatchObject({
        type: "SESSION_STATUS",
        session,
        controlledBy: null,
      }),
    );
  });

  test("runs as the peer commands, and its end clears the controller marker", async () => {
    const peers = await peerBackground();
    await peers.connect();
    const shop = await fakeBrowser.tabs.create({ url: "https://shop.example/" });
    const start = fromPeer("SESSION_START", { tabId: shop.id ?? -1 });
    await peers.receive(start);
    expect(peers.link.frames()).toContainEqual(
      expect.objectContaining({ type: "COMMAND_RESULT", requestId: start.id, ok: true }),
    );
    await vi.waitFor(() =>
      expect(peers.link.frames()).toContainEqual(
        expect.objectContaining({ type: "SESSION_STATUS", controlledBy: PEER }),
      ),
    );
    await peers.receive(fromPeer("SESSION_STOP", {}));
    expect(await remoteControllerRepository.read()).toBeNull();
    await vi.waitFor(() =>
      expect(peers.link.frames().at(-1)).toMatchObject({ type: "SESSION_STATUS", session: null }),
    );
  });

  test("ending a session clears the marker even without a link", async () => {
    await peerBackground();
    await remoteControllerRepository.write({ profileId: PEER });
    await recordingSessionRepository.write(session);
    await recordingSessionRepository.write(null);
    await vi.waitFor(async () => expect(await remoteControllerRepository.read()).toBeNull());
  });
});

describe("the peer's reports", () => {
  test("keep its tabs for the pages, and a new HELLO drops them", async () => {
    const peers = await peerBackground();
    await peers.connect();
    await peers.receive(fromPeer("TABS_CHANGED", { tabs: [TAB], currentId: 3 }));
    expect(await peers.routes.request({ type: "tabs" })).toEqual({ tabs: [TAB], currentId: 3 });
    await peers.receive(fromPeer("TABS_CHANGED", { tabs: [] }));
    expect(await peers.routes.request({ type: "tabs" })).toStrictEqual({ tabs: [] });
    await peers.receive(fromPeer("HELLO", { displayName: "Desk", extensionVersion: "0.1.0" }));
    const listed = peers.routes.request({ type: "tabs" });
    await vi.waitFor(() => expect(peers.link.sentTypes().at(-1)).toBe("GET_TABS"));
    const ask = peers.link.frames().at(-1) as unknown as { id: string };
    await peers.receive(fromPeer("TABS_SNAPSHOT", { requestId: ask.id, tabs: [TAB] }));
    expect(await listed).toStrictEqual({ tabs: [TAB] });
    expect(peers.link.notices.length).toBeGreaterThan(3);
  });

  test("a HELLO renames the authorized peer, and is answered with the session", async () => {
    const peers = await peerBackground();
    await peers.connect();
    await peers.receive(fromPeer("HELLO", { displayName: "Studio", extensionVersion: "0.2.0" }));
    expect(await authorizedPeersRepository.get(PEER)).toMatchObject({ displayName: "Studio" });
    expect(peers.link.frames().at(-1)).toMatchObject({ type: "SESSION_STATUS", session: null });
  });

  test("keep the peer's session, marked mine when this profile controls it", async () => {
    const peers = await peerBackground();
    await peers.connect();
    for (const [controlledBy, mine] of [
      [ME, true],
      [STRANGER, false],
      [null, false],
    ] as const) {
      await peers.receive(fromPeer("SESSION_STATUS", { session, controlledBy }));
      expect(await remoteRecordingsRepository.get(PEER)).toEqual({
        profileId: PEER,
        session,
        mine,
        connected: true,
      });
    }
    await peers.receive(fromPeer("SESSION_STATUS", { session: null, controlledBy: ME }));
    expect(await remoteRecordingsRepository.get(PEER)).toMatchObject({
      session: null,
      mine: false,
    });
  });

  test("log the peer's errors", async () => {
    const peers = await peerBackground();
    await peers.connect();
    await peers.receive(fromPeer("ERROR", { reason: "Invalid message." }));
    expect(peers.log).toHaveBeenCalledWith("[RECnRun peer]", "peer reported Invalid message.");
  });
});
