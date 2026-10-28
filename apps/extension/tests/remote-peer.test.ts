import type { RecordingSession } from "@recnrun/domain";
import * as v from "valibot";
import { describe, expect, test, vi } from "vite-plus/test";
import type { PeerRequest } from "@/messaging/peer-messages";
import type { TabSource } from "@/ports/tabs";
import type { PeerClient } from "@/views/peer-client";
import {
  eitherSession,
  remoteRecordings,
  remoteSessionTabs,
  remoteTabs,
} from "@/views/remote-peer";
import { memoryRecordingStore } from "./fake-extension";
import { PEER } from "./fake-peer";

const session: RecordingSession = { tabId: 4, status: "recording", banked: 0, since: 1 };
const REMOTE_TAB = { id: 9, windowId: 1, incognito: false, title: "Peer", url: "https://p/" };

/** A client that records each request and answers it with `answer`, validated by the caller's schema. */
function recordingClient(answer: unknown = {}) {
  const requests: PeerRequest[] = [];
  const unwatch = vi.fn();
  const client: PeerClient = {
    ask: async (request, schema) => {
      requests.push(request);
      return v.parse(schema, answer);
    },
    watch: vi.fn(() => unwatch),
  };
  return { client, requests, unwatch };
}

type Report = { session: RecordingSession | null; mine: boolean; connected: boolean };

/** The background's copy of `PEER`'s last report. */
function mirrorOf(remote: Report | null) {
  const unwatch = vi.fn();
  const read = async () => remote && { profileId: PEER, ...remote };
  return { read, watch: vi.fn(() => unwatch), unwatch };
}

/** A tab source with one tab under `id`, whose subscriptions are counted. */
function tabSource(id: number) {
  const unwatch = vi.fn();
  const tabs = { tabs: [{ ...REMOTE_TAB, id }] };
  const source: TabSource = { read: async () => tabs, watch: vi.fn(() => unwatch) };
  return { source, tabs, unwatch };
}

describe("remoteTabs", () => {
  test("asks the background for the peer's tabs and validates them", async () => {
    const { client, requests } = recordingClient({ tabs: [REMOTE_TAB], currentId: 9 });
    expect(await remoteTabs(client, PEER).read()).toEqual({ tabs: [REMOTE_TAB], currentId: 9 });
    expect(requests).toEqual([{ type: "tabs", peer: PEER }]);
    const incognito = recordingClient({ tabs: [{ ...REMOTE_TAB, incognito: true }] }).client;
    await expect(remoteTabs(incognito, PEER).read()).rejects.toThrow();
  });

  test("hears every peer notice as a change", () => {
    const { client, unwatch } = recordingClient();
    const onChange = vi.fn();
    remoteTabs(client, PEER).watch(onChange)();
    expect(client.watch).toHaveBeenCalledWith(onChange);
    expect(unwatch).toHaveBeenCalledOnce();
  });
});

describe("remoteRecordings", () => {
  test.each([
    ["the session this profile controls", { session, mine: true, connected: true }, session],
    ["nothing for it while the link is down", { session, mine: true, connected: false }, null],
    [
      "nothing for a session the peer's own user runs",
      { session, mine: false, connected: true },
      null,
    ],
    ["nothing before any report", null, null],
  ])("reads %s", async (_, remote, expected) => {
    const store = remoteRecordings(recordingClient().client, mirrorOf(remote));
    expect(await store.read()).toEqual(expected);
  });

  test("writes as commands to the executor of the peer that runs it", async () => {
    const { client, requests } = recordingClient();
    const store = remoteRecordings(client, mirrorOf({ session, mine: true, connected: true }));
    await store.write({ ...session, status: "paused" });
    await store.write(null);
    expect(requests).toEqual([
      { type: "session-set", peer: PEER, status: "paused" },
      { type: "session-stop", peer: PEER },
    ]);
    const none = remoteRecordings(client, mirrorOf({ session, mine: false, connected: true }));
    await expect(none.write(null)).rejects.toThrow("This profile controls no session");
  });

  test("lists the tabs of the peer that runs it, and none without one", async () => {
    const { client, requests } = recordingClient({ tabs: [REMOTE_TAB] });
    const onChange = vi.fn();
    remoteSessionTabs(client, mirrorOf(null)).watch(onChange);
    expect(client.watch).toHaveBeenCalledWith(onChange);
    expect(await remoteSessionTabs(client, mirrorOf(null)).read()).toEqual({ tabs: [] });
    const running = mirrorOf({ session, mine: true, connected: true });
    expect(await remoteSessionTabs(client, running).read()).toEqual({ tabs: [REMOTE_TAB] });
    expect(requests).toEqual([{ type: "tabs", peer: PEER }]);
  });

  test("watches the mirror", () => {
    const mirror = mirrorOf(null);
    const onChange = vi.fn();
    remoteRecordings(recordingClient().client, mirror).watch(onChange)();
    expect(mirror.watch).toHaveBeenCalledWith(onChange);
    expect(mirror.unwatch).toHaveBeenCalledOnce();
  });
});

describe("eitherSession", () => {
  function sides(localSession: RecordingSession | null) {
    const local = { recordings: memoryRecordingStore(localSession), ...tabSource(1) };
    const remote = { recordings: memoryRecordingStore({ ...session, tabId: 9 }), ...tabSource(9) };
    const either = eitherSession(
      { recordings: local.recordings, tabs: local.source },
      { recordings: remote.recordings, tabs: remote.source },
    );
    return { local, remote, either };
  }

  test("floats this profile's own session while it runs", async () => {
    const { local, remote, either } = sides(session);
    expect(await either.recordings.read()).toEqual(session);
    expect(await either.tabs.read()).toBe(local.tabs);
    await either.recordings.write({ ...session, status: "paused" });
    expect(await local.recordings.read()).toEqual({ ...session, status: "paused" });
    expect(await remote.recordings.read()).toEqual({ ...session, tabId: 9 });
  });

  test("else floats the session it controls in the other profile", async () => {
    const { local, remote, either } = sides(null);
    expect(await either.recordings.read()).toEqual({ ...session, tabId: 9 });
    expect(await either.tabs.read()).toBe(remote.tabs);
    await either.recordings.write(null);
    expect(await remote.recordings.read()).toBeNull();
    expect(await local.recordings.read()).toBeNull();
  });

  test("hears either side's session and tabs until unwatched", async () => {
    const { local, remote, either } = sides(null);
    const [onSessions, onTabs] = [vi.fn(), vi.fn()];
    const unwatchSessions = either.recordings.watch(onSessions);
    const unwatchTabs = either.tabs.watch(onTabs);
    expect(local.source.watch).toHaveBeenCalledWith(onTabs);
    expect(remote.source.watch).toHaveBeenCalledWith(onTabs);
    await local.recordings.write(session);
    await remote.recordings.write(null);
    // The tabs follow the session too, since a change of session changes whose tabs float.
    expect(onSessions).toHaveBeenCalledTimes(2);
    expect(onTabs).toHaveBeenCalledTimes(2);
    unwatchSessions();
    unwatchTabs();
    expect(local.unwatch).toHaveBeenCalledOnce();
    expect(remote.unwatch).toHaveBeenCalledOnce();
    await local.recordings.write(null);
    expect(onSessions).toHaveBeenCalledTimes(2);
    expect(onTabs).toHaveBeenCalledTimes(2);
  });
});
