import * as v from "valibot";
import { beforeEach, describe, expect, test } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { PresenceSchema } from "@/p2p/folder-rendezvous";
import { parseLauncherRecord } from "@/p2p/launcher-record";
import { createPins } from "@/p2p/pins";
import { MemberSchema, parsePeerFrame, peerMessage } from "@/p2p/protocol";
import { RegistrationSchema } from "@/p2p/registry";
import { RoleRecordSchema, createRoles } from "@/p2p/roles";
import { peerPinsRepository, roleRepository } from "@/storage/peer-repository";

const NOW = 1_700_000_000_000;
const ME = "11111111-1111-4111-8111-111111111111";
// The Default's id sorts after its workers' ids, so the offerer election picks a worker.
const MASTER = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const LOW_WORKER = "00000000-0000-4000-8000-000000000000";
const OTHER_MASTER = "33333333-3333-4333-8333-333333333333";
const CLONE = "44444444-4444-4444-8444-444444444444";
const MASTER_FP = "AB:CD:EF";
const OTHER_FP = "12:34:56";

const pins = () => createPins(peerPinsRepository, () => NOW);
const roles = () => createRoles({ role: roleRepository, pins: pins(), now: () => NOW });
const master = { profileId: MASTER, fingerprint: MASTER_FP, source: "pairing" } as const;
const binding = {
  role: "worker",
  masterProfileId: MASTER,
  masterFingerprint: MASTER_FP,
  boundAt: NOW,
  source: "pairing",
};

/** The handshake proved `fingerprint` for `profileId`, as a first verified link pins it. */
const proved = (profileId: string, fingerprint: string) =>
  pins().pin(profileId, fingerprint, "pairing-code");

beforeEach(() => {
  fakeBrowser.reset();
});

describe("the role of a profile", () => {
  test("is a worker with no master until the local channel binds one", async () => {
    expect(await roles().roleOf()).toBe("worker");
    expect(await roles().record()).toBeNull();
  });

  test("a role=master field in a message or a presence changes nothing", async () => {
    const hello = peerMessage(
      "HELLO",
      { from: OTHER_MASTER, to: ME },
      { displayName: "Default", extensionVersion: "0.1.0" },
    );
    expect(parsePeerFrame(JSON.stringify(hello))).toEqual(hello);
    expect(parsePeerFrame(JSON.stringify({ ...hello, role: "master" }))).toBeUndefined();
    const presence = {
      profileId: OTHER_MASTER,
      displayName: "Default",
      fingerprint: OTHER_FP,
      createdAt: NOW,
      expiresAt: NOW + 30_000,
    };
    expect(v.is(PresenceSchema, presence)).toBe(true);
    expect(v.is(PresenceSchema, { ...presence, role: "master" })).toBe(false);
    const registration = { ...presence, namespace: "lab", boot: crypto.randomUUID() };
    expect(v.is(RegistrationSchema, registration)).toBe(true);
    expect(v.is(RegistrationSchema, { ...registration, role: "master" })).toBe(false);
    const member = { profileId: OTHER_MASTER, displayName: "Default", fingerprint: OTHER_FP };
    expect(v.is(MemberSchema, member)).toBe(true);
    expect(v.is(MemberSchema, { ...member, role: "master" })).toBe(false);
    // Even over a link that proved its certificate, the claimant is no master here.
    await proved(OTHER_MASTER, OTHER_FP);
    expect(await roles().roleOf()).toBe("worker");
    expect(await roles().isMasterIdentity(OTHER_MASTER, OTHER_FP)).toBe(false);
    await proved(MASTER, MASTER_FP);
    await roles().bind(master);
    expect(await roles().isMasterIdentity(OTHER_MASTER, OTHER_FP)).toBe(false);
  });

  test("a clone with a Default/ profile directory is a worker", async () => {
    const [clone] = parseLauncherRecord(
      `userDataDir=/Users/me/RECnRun/clones/A\nprofileDirectory=Default\nprofileId=${CLONE}\n`,
    );
    expect(clone?.profileDirectory).toBe("Default");
    // The clone itself: no record names it master, so its directory makes it nothing more.
    expect(await roles().roleOf()).toBe("worker");
    expect((await roles().bind(master)).ok).toBe(true);
    expect(await roles().roleOf()).toBe("worker");
    // A worker of the Default: the clone's verified link does not make it the master.
    await proved(CLONE, OTHER_FP);
    await proved(MASTER, MASTER_FP);
    expect(await roles().isMasterIdentity(CLONE, OTHER_FP)).toBe(false);
    expect(await roles().isMasterIdentity(MASTER, MASTER_FP)).toBe(true);
  });

  test("a worker whose profileId sorts lower than the master's stays a worker", async () => {
    expect([MASTER, LOW_WORKER].toSorted()).toEqual([LOW_WORKER, MASTER]);
    await proved(MASTER, MASTER_FP);
    await roles().bind(master);
    expect(await roles().roleOf()).toBe("worker");
    expect(await roles().isMasterIdentity(LOW_WORKER, OTHER_FP)).toBe(false);
    // The master's own record makes the low id no master either.
    fakeBrowser.reset();
    await roles().becomeMaster({ profileId: MASTER, fingerprint: MASTER_FP });
    await proved(LOW_WORKER, OTHER_FP);
    expect(await roles().roleOf()).toBe("master");
    expect(await roles().isMasterIdentity(LOW_WORKER, OTHER_FP)).toBe(false);
  });
});

describe("bind", () => {
  test("records the master's identity and certificate, with the time and source", async () => {
    await proved(MASTER, MASTER_FP);
    expect(await roles().bind(master)).toEqual({ ok: true, binding });
    expect(await roleRepository.read()).toEqual(binding);
  });

  test("a second different master is refused and the first binding stands", async () => {
    await roles().bind(master);
    const other = { ...master, profileId: OTHER_MASTER };
    expect(await roles().bind(other)).toEqual({ ok: false, reason: "bound-elsewhere", binding });
    // The same profile with another certificate is another master too.
    const renewed = { ...master, fingerprint: OTHER_FP };
    expect(await roles().bind(renewed)).toEqual({ ok: false, reason: "bound-elsewhere", binding });
    expect(await roleRepository.read()).toEqual(binding);
  });

  test("binding the same master again changes nothing", async () => {
    await roles().bind(master);
    const later = createRoles({ role: roleRepository, pins: pins(), now: () => NOW + 1 });
    expect(await later.bind(master)).toEqual({ ok: true, binding });
  });

  test("two binds at once leave one master", async () => {
    const other = { ...master, profileId: OTHER_MASTER };
    const store = roles();
    const outcomes = await Promise.all([store.bind(master), store.bind(other)]);
    expect(outcomes.map(({ ok }) => ok)).toEqual([true, false]);
    expect(await roleRepository.read()).toEqual(binding);
  });

  test("refuses a master whose pinned certificate is another", async () => {
    await proved(MASTER, OTHER_FP);
    expect(await roles().bind(master)).toEqual({ ok: false, reason: "pinned-different" });
    expect(await roleRepository.read()).toBeNull();
  });

  test("refuses a malformed master", async () => {
    const malformed = { ...master, profileId: "not-a-uuid" };
    expect(await roles().bind(malformed)).toEqual({ ok: false, reason: "malformed" });
  });

  test("the master is never a worker", async () => {
    await roles().becomeMaster({ profileId: MASTER, fingerprint: MASTER_FP });
    const other = { ...master, profileId: OTHER_MASTER };
    expect(await roles().bind(other)).toEqual({ ok: false, reason: "master" });
    expect(await roles().roleOf()).toBe("master");
  });
});

describe("becomeMaster", () => {
  test("records the Default's own identity and certificate", async () => {
    const self = { profileId: MASTER, fingerprint: MASTER_FP };
    expect(await roles().becomeMaster(self)).toEqual({
      ok: true,
      record: { role: "master", ...self },
    });
    expect(await roles().becomeMaster(self)).toEqual({
      ok: true,
      record: { role: "master", ...self },
    });
  });

  test("never promotes a bound worker, even with its master away", async () => {
    await roles().bind(master);
    const self = { profileId: ME, fingerprint: OTHER_FP };
    expect(await roles().becomeMaster(self)).toEqual({ ok: false, reason: "bound", binding });
    expect(await roles().roleOf()).toBe("worker");
  });

  test("keeps the first master record against another identity", async () => {
    const self = { profileId: MASTER, fingerprint: MASTER_FP };
    await roles().becomeMaster(self);
    const other = { profileId: MASTER, fingerprint: OTHER_FP };
    expect(await roles().becomeMaster(other)).toEqual({
      ok: false,
      reason: "master-differs",
      record: { role: "master", ...self },
    });
  });

  test("refuses a malformed identity", async () => {
    const self = { profileId: MASTER, fingerprint: "not a fingerprint" };
    expect(await roles().becomeMaster(self)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("isMasterIdentity", () => {
  test("is true only for the bound master's id and certificate, pinned as they are", async () => {
    await roles().bind(master);
    // Bound before any link: nothing proved the certificate yet.
    expect(await roles().isMasterIdentity(MASTER, MASTER_FP)).toBe(false);
    await proved(MASTER, MASTER_FP);
    expect(await roles().isMasterIdentity(MASTER, MASTER_FP)).toBe(true);
    expect(await roles().isMasterIdentity(MASTER, OTHER_FP)).toBe(false);
    expect(await roles().isMasterIdentity(OTHER_MASTER, MASTER_FP)).toBe(false);
  });

  test("is false when the pin is another certificate than the binding's", async () => {
    await roles().bind(master);
    await proved(MASTER, OTHER_FP);
    expect(await roles().isMasterIdentity(MASTER, MASTER_FP)).toBe(false);
    expect(await roles().isMasterIdentity(MASTER, OTHER_FP)).toBe(false);
  });

  test("is false on the master itself and on a template", async () => {
    await proved(MASTER, MASTER_FP);
    await roles().becomeMaster({ profileId: MASTER, fingerprint: MASTER_FP });
    expect(await roles().isMasterIdentity(MASTER, MASTER_FP)).toBe(false);
    fakeBrowser.reset();
    await proved(MASTER, MASTER_FP);
    await roles().holdAsTemplate();
    expect(await roles().isMasterIdentity(MASTER, MASTER_FP)).toBe(false);
  });
});

describe("template", () => {
  test("blocks every outward action from the start", async () => {
    expect(await roles().holdAsTemplate()).toEqual({ ok: true });
    expect(await roles().roleOf()).toBe("template");
    for (const action of ["announce", "discover", "work"] as const)
      expect(await roles().mayAct(action)).toBe(false);
    expect(await roles().bind(master)).toEqual({ ok: false, reason: "template" });
    const self = { profileId: MASTER, fingerprint: MASTER_FP };
    expect(await roles().becomeMaster(self)).toEqual({ ok: false, reason: "template" });
  });

  test("workers and the master act; a base with a role is never made a template", async () => {
    for (const action of ["announce", "discover", "work"] as const)
      expect(await roles().mayAct(action)).toBe(true);
    await roles().bind(master);
    expect(await roles().holdAsTemplate()).toEqual({ ok: false, reason: "worker" });
    expect(await roles().mayAct("work")).toBe(true);
    fakeBrowser.reset();
    await roles().becomeMaster({ profileId: MASTER, fingerprint: MASTER_FP });
    expect(await roles().holdAsTemplate()).toEqual({ ok: false, reason: "master" });
    expect(await roles().mayAct("announce")).toBe(true);
  });
});

describe("the stored record", () => {
  test("the binding survives a reload of the store", async () => {
    await proved(MASTER, MASTER_FP);
    await roles().bind(master);
    // What Chrome keeps on disk across a restart: the stored values, as JSON.
    const kept = JSON.parse(JSON.stringify(await fakeBrowser.storage.local.get())) as Record<
      string,
      unknown
    >;
    fakeBrowser.reset();
    await fakeBrowser.storage.local.set(kept);
    const reloaded = roles();
    expect(await reloaded.roleOf()).toBe("worker");
    expect(await reloaded.record()).toEqual(binding);
    expect(await reloaded.isMasterIdentity(MASTER, MASTER_FP)).toBe(true);
  });

  test("an unreadable store binds nothing and proves no master", async () => {
    const broken = {
      read: () => Promise.reject(new Error("The stored local:role does not match its schema.")),
      write: () => Promise.reject(new Error("quota")),
    };
    const failing = createRoles({ role: broken, pins: pins(), now: () => NOW });
    expect(await failing.bind(master)).toEqual({
      ok: false,
      reason: "store-failed",
      error: "The stored local:role does not match its schema.",
    });
    await proved(MASTER, MASTER_FP);
    expect(await failing.isMasterIdentity(MASTER, MASTER_FP)).toBe(false);
    expect(await failing.mayAct("announce")).toBe(false);
  });

  test("refuses a stored role that carries anything else", () => {
    expect(v.is(RoleRecordSchema, binding)).toBe(true);
    expect(v.is(RoleRecordSchema, { ...binding, displayName: "Default" })).toBe(false);
    expect(v.is(RoleRecordSchema, { role: "template", masterProfileId: MASTER })).toBe(false);
    expect(v.is(RoleRecordSchema, { role: "controller" })).toBe(false);
  });
});
