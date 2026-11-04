import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { createPeerChannel } from "@/background/peer-channel";
import { COMMAND_TYPES, MESSAGE_CLASSES, authorizeCommand } from "@/p2p/authorization";
import { createPins } from "@/p2p/pins";
import { peerMessage, peerTypes } from "@/p2p/protocol";
import type { PeerMessage, PeerPayload, PeerType } from "@/p2p/protocol";
import { createRoles } from "@/p2p/roles";
import { roleStores, storedRoles } from "@/storage/hierarchy-repository";
import { peerPinsRepository } from "@/storage/peer-repository";
import { identityOf, signAs } from "./test-identity";

const ME = "11111111-1111-4111-8111-111111111111";
// The Default's id sorts after its workers' ids, so the offerer election picks a worker.
const MASTER = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const WORKER = "22222222-2222-4222-8222-222222222222";
const LOW_WORKER = "00000000-0000-4000-8000-000000000000";
const STRANGER = "33333333-3333-4333-8333-333333333333";
const FINGERPRINTS: Record<string, string> = {
  [ME]: "11:11",
  [MASTER]: "AA:AA",
  [WORKER]: "22:22",
  [LOW_WORKER]: "00:00",
  [STRANGER]: "33:33",
};
const fp = (profileId: string) => FINGERPRINTS[profileId] ?? "";
const KEYS: Record<string, string> = Object.fromEntries(
  await Promise.all(Object.keys(FINGERPRINTS).map(async (id) => [id, await identityOf(id)])),
);
const key = (profileId: string) => KEYS[profileId] ?? "";
const OTHER_KEY = await identityOf("other");

/** This profile's channel, with every peer authorized and linked under its certificate and key. */
function channel(identities: Record<string, string> = KEYS) {
  const log = vi.fn<(entry: string) => void>();
  const sent: PeerMessage[] = [];
  const created = createPeerChannel({
    askLink: async (command) => {
      if (command.type === "send") sent.push(JSON.parse(command.frame) as PeerMessage);
      return { sent: true };
    },
    identity: async () => ({ profileId: ME, displayName: "Me" }),
    authorized: {
      get: async (id) => ({
        profileId: id,
        displayName: "Peer",
        fingerprint: fp(id),
        identity: identities[id] ?? "",
      }),
    },
    link: { get: async () => ({ state: "connected", verified: true }) },
    log,
    replyTimeoutMs: 50,
  });
  return { ...created, log, sent };
}

const from = <T extends PeerType>(type: T, author: string, payload: PeerPayload<T>) =>
  peerMessage(type, { from: author, to: ME }, payload);
const frame = (message: PeerMessage) => JSON.stringify(message);
const start = (author: string) => from("SESSION_START", author, { tabId: 7 });

/** The first verified link to each peer pins its key, as pairing-flows does. */
async function meet(...peers: string[]) {
  const pins = createPins(peerPinsRepository());
  for (const peer of peers)
    await pins.pin(peer, { identity: key(peer), fingerprint: fp(peer) }, "pairing-code");
}

async function workerOf(master: string) {
  await meet(master);
  const bound = await storedRoles().bind({
    profileId: master,
    identity: key(master),
    source: "pairing",
  });
  expect(bound.ok).toBe(true);
}

async function masterOf(...workers: string[]) {
  const roles = storedRoles();
  await roles.becomeMaster({ profileId: ME, identity: key(ME) });
  await meet(...workers);
  for (const worker of workers)
    await roles.bindWorker({ profileId: worker, identity: key(worker), source: "pairing" });
}

beforeEach(() => {
  fakeBrowser.reset();
});

describe("the protocol's message classes", () => {
  test("classify every protocol type, and the commands are exactly the executor's", () => {
    expect(Object.keys(MESSAGE_CLASSES).toSorted()).toEqual(peerTypes().toSorted());
    const commands = Object.entries(MESSAGE_CLASSES)
      .filter(([, kind]) => kind === "command")
      .map(([type]) => type);
    expect([...COMMAND_TYPES].toSorted()).toEqual(commands.toSorted());
  });
});

describe("a command", () => {
  test("from the bound master is accepted", async () => {
    await workerOf(MASTER);
    const { receive, log, refused } = channel();
    const command = start(MASTER);
    expect(await receive(frame(command), MASTER)).toEqual({ kind: "accepted", message: command });
    expect(log).toHaveBeenCalledWith("received SESSION_START");
    expect(refused()).toBe(0);
  });

  test("worker to worker is refused, with one log line naming the type, author, and reason", async () => {
    await workerOf(MASTER);
    await meet(WORKER);
    const { receive, log, refused } = channel();
    const reason = "not the bound master";
    expect(await receive(frame(start(WORKER)), WORKER)).toEqual({ kind: "refused", reason });
    expect(log.mock.calls).toEqual([[`REFUSED SESSION_START from ${WORKER}: ${reason}`]]);
    expect(refused()).toBe(1);
  });

  test("worker to master is refused", async () => {
    await masterOf(WORKER);
    const { receive, refused } = channel();
    const activate = from("ACTIVATE_TAB", WORKER, { tabId: 7 });
    expect(await receive(frame(activate), WORKER)).toMatchObject({ kind: "refused" });
    expect(await receive(frame(from("SESSION_STOP", WORKER, {})), WORKER)).toMatchObject({
      kind: "refused",
    });
    expect(refused()).toBe(2);
  });

  test("with a forged role=master is refused", async () => {
    await workerOf(MASTER);
    await meet(STRANGER);
    const { receive, refused } = channel();
    const forged = { ...start(STRANGER), role: "master" };
    expect(await receive(JSON.stringify(forged), STRANGER)).toEqual({ kind: "invalid" });
    expect(await receive(frame(start(STRANGER)), STRANGER)).toMatchObject({ kind: "refused" });
    expect(refused()).toBe(1);
  });

  test("from a lower-profileId worker that became the offerer is still refused", async () => {
    expect([MASTER, LOW_WORKER].toSorted()[0]).toBe(LOW_WORKER);
    await workerOf(MASTER);
    await meet(LOW_WORKER);
    const { receive } = channel();
    expect(await receive(frame(start(LOW_WORKER)), LOW_WORKER)).toMatchObject({
      kind: "refused",
    });
    fakeBrowser.reset();
    await masterOf(LOW_WORKER);
    expect(await receive(frame(start(LOW_WORKER)), LOW_WORKER)).toMatchObject({
      kind: "refused",
    });
  });

  test("relayed for a worker keeps the worker as its author, even when the relay is the master", async () => {
    await workerOf(MASTER);
    await meet(WORKER);
    const relay = { profileId: MASTER, identity: key(MASTER) };
    const verdict = await authorizeCommand(start(WORKER), relay, storedRoles());
    expect(verdict).toEqual({
      ok: false,
      reason: `relayed by ${MASTER}, so its author's certificate is unproven`,
    });
    // Over the master's link, the channel never takes the worker's id at all.
    const { receive, refused } = channel();
    expect(await receive(frame(start(WORKER)), MASTER)).toEqual({ kind: "unauthorized" });
    expect(refused()).toBe(0);
  });

  test("from the master's id over a link proving another identity key is refused", async () => {
    await workerOf(MASTER);
    const { receive } = channel({ ...KEYS, [MASTER]: OTHER_KEY });
    expect(await receive(frame(start(MASTER)), MASTER)).toMatchObject({ kind: "refused" });
  });
});

describe("results and status", () => {
  test("reach a worker from any verified peer, both ways", async () => {
    await workerOf(MASTER);
    const { receive } = channel();
    const snapshot = from("TABS_SNAPSHOT", WORKER, { requestId: crypto.randomUUID(), tabs: [] });
    expect(await receive(frame(snapshot), WORKER)).toMatchObject({ kind: "accepted" });
    const identity = await signAs({ profileId: STRANGER, fingerprint: fp(STRANGER) });
    const hello = from("HELLO", STRANGER, {
      displayName: "Desk",
      extensionVersion: "0.1.0",
      identity,
    });
    expect(await receive(frame(hello), STRANGER)).toMatchObject({ kind: "accepted" });
  });

  test("the master accepts them from a bound worker and refuses them from an unbound profile", async () => {
    await masterOf(WORKER);
    await meet(STRANGER);
    const { receive, request, log, sent } = channel();
    const result = (author: string) =>
      from("COMMAND_RESULT", author, { requestId: crypto.randomUUID(), ok: true });
    expect(await receive(frame(result(WORKER)), WORKER)).toMatchObject({ kind: "accepted" });
    const reason = "not a bound worker";
    expect(await receive(frame(result(STRANGER)), STRANGER)).toEqual({ kind: "refused", reason });
    expect(log).toHaveBeenCalledWith(`REFUSED COMMAND_RESULT from ${STRANGER}: ${reason}`);
    // A refused reply answers no request.
    const asked = request(STRANGER, "GET_TABS", {});
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const reply = from("TABS_SNAPSHOT", STRANGER, { requestId: sent[0]?.id ?? "", tabs: [] });
    expect(await receive(frame(reply), STRANGER)).toMatchObject({ kind: "refused" });
    await expect(asked).rejects.toThrow("The other profile did not answer in time.");
  });

  test("the master refuses a bound worker's report over a link proving another identity key", async () => {
    await masterOf(WORKER);
    const { receive } = channel({ ...KEYS, [WORKER]: OTHER_KEY });
    const changed = from("TABS_CHANGED", WORKER, { tabs: [] });
    expect(await receive(frame(changed), WORKER)).toMatchObject({ kind: "refused" });
  });
});

describe("heartbeat and signaling", () => {
  test("pass from any verified peer and grant nothing", async () => {
    await masterOf(WORKER);
    await meet(STRANGER);
    const { receive, refused } = channel();
    expect(await receive(frame(from("BYE", STRANGER, {})), STRANGER)).toMatchObject({
      kind: "accepted",
    });
    const invite = from("INVITE", STRANGER, { origin: STRANGER, target: WORKER });
    expect(await receive(frame(invite), STRANGER)).toMatchObject({ kind: "accepted" });
    const members = from("MEMBERS", STRANGER, { members: [] });
    expect(await receive(frame(members), STRANGER)).toMatchObject({ kind: "accepted" });
    const roles = storedRoles();
    expect(await roles.roleOf()).toBe("master");
    expect(await roles.isBoundWorker(STRANGER, key(STRANGER))).toBe(false);
    expect(await receive(frame(start(STRANGER)), STRANGER)).toMatchObject({ kind: "refused" });
    const status = from("SESSION_STATUS", STRANGER, { session: null, controlledBy: null });
    expect(await receive(frame(status), STRANGER)).toMatchObject({ kind: "refused" });
    expect(refused()).toBe(2);
  });

  test("a heartbeat on a worker makes its sender no master", async () => {
    await workerOf(MASTER);
    await meet(STRANGER);
    const { receive } = channel();
    expect(await receive(frame(from("BYE", STRANGER, {})), STRANGER)).toMatchObject({
      kind: "accepted",
    });
    expect(await storedRoles().isMasterIdentity(STRANGER, key(STRANGER))).toBe(false);
  });
});

describe("a profile that cannot place itself", () => {
  test("as a template refuses everything, the heartbeat included", async () => {
    await storedRoles().holdAsTemplate();
    await meet(MASTER);
    const { receive } = channel();
    const reason = "this profile is a template";
    for (const message of [start(MASTER), from("BYE", MASTER, {}), from("GET_TABS", MASTER, {})])
      expect(await receive(frame(message), MASTER)).toEqual({ kind: "refused", reason });
  });

  test("with an unreadable role refuses everything", async () => {
    await fakeBrowser.storage.local.set({ role: { role: "controller" } });
    const { receive } = channel();
    expect(await receive(frame(from("BYE", MASTER, {})), MASTER)).toEqual({
      kind: "refused",
      reason: "the recorded role cannot be read",
    });
  });
});

describe("the controls a dashboard offers", () => {
  test("the master controls itself and each worker it bound, never a stranger", async () => {
    await masterOf(WORKER);
    const roles = storedRoles();
    expect(await roles.controls(ME, ME)).toBe(true);
    expect(await roles.controls(WORKER, ME)).toBe(true);
    expect(await roles.controls(STRANGER, ME)).toBe(false);
  });

  test("a worker controls only itself, not its master or a worker its store still names", async () => {
    await meet(WORKER);
    const bound = { identity: key(WORKER), boundAt: 1, source: "pairing" } as const;
    await roleStores().workers.set(WORKER, bound);
    await workerOf(MASTER);
    const roles = storedRoles();
    expect(await roles.controls(ME, ME)).toBe(true);
    expect(await roles.controls(MASTER, ME)).toBe(false);
    expect(await roles.controls(WORKER, ME)).toBe(false);
  });

  test("a store of bound workers that cannot be read controls none of them", async () => {
    await masterOf(WORKER);
    const { role, workers: stored } = roleStores();
    const workers = { ...stored, get: () => Promise.reject(new Error("quota")) };
    const roles = createRoles({ role, workers, pins: createPins(peerPinsRepository()) });
    expect(await roles.controls(WORKER, ME)).toBe(false);
  });
});
