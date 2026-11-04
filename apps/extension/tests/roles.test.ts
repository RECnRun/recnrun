import * as v from "valibot";
import { beforeEach, describe, expect, test } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { PresenceSchema } from "@/p2p/folder-rendezvous";
import { parseLauncherRecord } from "@/p2p/launcher-record";
import { MemberSchema, parsePeerFrame, peerMessage } from "@/p2p/protocol";
import { RegistrationSchema } from "@/p2p/registry";
import { createRoles } from "@/p2p/roles";
import {
  CLONE,
  FINGERPRINT,
  LOW_WORKER,
  MASTER,
  MASTER_KEY,
  ME,
  NOW,
  OTHER_KEY,
  OTHER_MASTER,
  binding,
  boundWorkersRepository,
  master,
  pins,
  proved,
  roleRepository,
  roles,
  stores,
} from "./role-fixture";
import { signAs } from "./test-identity";

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
      {
        displayName: "Default",
        extensionVersion: "0.1.0",
        identity: await signAs({ profileId: OTHER_MASTER, fingerprint: FINGERPRINT }),
      },
    );
    expect(parsePeerFrame(JSON.stringify(hello))).toEqual(hello);
    expect(parsePeerFrame(JSON.stringify({ ...hello, role: "master" }))).toBeUndefined();
    const presence = {
      profileId: OTHER_MASTER,
      displayName: "Default",
      fingerprint: FINGERPRINT,
      identity: await signAs({ profileId: OTHER_MASTER, fingerprint: FINGERPRINT }),
      createdAt: NOW,
      expiresAt: NOW + 30_000,
    };
    expect(v.is(PresenceSchema, presence)).toBe(true);
    expect(v.is(PresenceSchema, { ...presence, role: "master" })).toBe(false);
    const registration = { ...presence, namespace: "lab", boot: crypto.randomUUID() };
    expect(v.is(RegistrationSchema, registration)).toBe(true);
    expect(v.is(RegistrationSchema, { ...registration, role: "master" })).toBe(false);
    const member = {
      profileId: OTHER_MASTER,
      displayName: "Default",
      fingerprint: FINGERPRINT,
      identity: OTHER_KEY,
    };
    expect(v.is(MemberSchema, member)).toBe(true);
    expect(v.is(MemberSchema, { ...member, role: "master" })).toBe(false);
    // Even over a link that proved its certificate and key, the claimant is no master here.
    await proved(OTHER_MASTER, OTHER_KEY);
    expect(await roles().roleOf()).toBe("worker");
    expect(await roles().isMasterIdentity(OTHER_MASTER, OTHER_KEY)).toBe(false);
    await proved(MASTER, MASTER_KEY);
    await roles().bind(master);
    expect(await roles().isMasterIdentity(OTHER_MASTER, OTHER_KEY)).toBe(false);
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
    await proved(CLONE, OTHER_KEY);
    await proved(MASTER, MASTER_KEY);
    expect(await roles().isMasterIdentity(CLONE, OTHER_KEY)).toBe(false);
    expect(await roles().isMasterIdentity(MASTER, MASTER_KEY)).toBe(true);
  });

  test("a worker whose profileId sorts lower than the master's stays a worker", async () => {
    expect([MASTER, LOW_WORKER].toSorted()).toEqual([LOW_WORKER, MASTER]);
    await proved(MASTER, MASTER_KEY);
    await roles().bind(master);
    expect(await roles().roleOf()).toBe("worker");
    expect(await roles().isMasterIdentity(LOW_WORKER, OTHER_KEY)).toBe(false);
    // The master's own record makes the low id no master either.
    fakeBrowser.reset();
    await roles().becomeMaster({ profileId: MASTER, identity: MASTER_KEY });
    await proved(LOW_WORKER, OTHER_KEY);
    expect(await roles().roleOf()).toBe("master");
    expect(await roles().isMasterIdentity(LOW_WORKER, OTHER_KEY)).toBe(false);
  });
});

describe("bind", () => {
  test("records the master's profile and identity key, with the time and source", async () => {
    await proved(MASTER, MASTER_KEY);
    expect(await roles().bind(master)).toEqual({ ok: true, binding });
    expect(await roleRepository.read()).toEqual(binding);
  });

  test("a second different master is refused and the first binding stands", async () => {
    await roles().bind(master);
    const other = { ...master, profileId: OTHER_MASTER };
    expect(await roles().bind(other)).toEqual({ ok: false, reason: "bound-elsewhere", binding });
    // The same profile with another identity key is another master too.
    const rekeyed = { ...master, identity: OTHER_KEY };
    expect(await roles().bind(rekeyed)).toEqual({ ok: false, reason: "bound-elsewhere", binding });
    expect(await roleRepository.read()).toEqual(binding);
  });

  test("binding the same master again changes nothing", async () => {
    await roles().bind(master);
    const later = createRoles({ ...stores, pins: pins(), now: () => NOW + 1 });
    expect(await later.bind(master)).toEqual({ ok: true, binding });
  });

  test("two binds at once leave one master", async () => {
    const other = { ...master, profileId: OTHER_MASTER };
    const store = roles();
    const outcomes = await Promise.all([store.bind(master), store.bind(other)]);
    expect(outcomes.map(({ ok }) => ok)).toEqual([true, false]);
    expect(await roleRepository.read()).toEqual(binding);
  });

  test("refuses a master whose pinned identity key is another", async () => {
    await proved(MASTER, OTHER_KEY);
    expect(await roles().bind(master)).toEqual({ ok: false, reason: "pinned-different" });
    expect(await roleRepository.read()).toBeNull();
  });

  test("refuses a malformed master", async () => {
    const malformed = { ...master, profileId: "not-a-uuid" };
    expect(await roles().bind(malformed)).toEqual({ ok: false, reason: "malformed" });
  });

  test("the master is never a worker", async () => {
    await roles().becomeMaster({ profileId: MASTER, identity: MASTER_KEY });
    const other = { ...master, profileId: OTHER_MASTER };
    expect(await roles().bind(other)).toEqual({ ok: false, reason: "master" });
    expect(await roles().roleOf()).toBe("master");
  });
});

describe("becomeMaster", () => {
  test("records the Default's own profile and identity key", async () => {
    const self = { profileId: MASTER, identity: MASTER_KEY };
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
    const self = { profileId: ME, identity: OTHER_KEY };
    expect(await roles().becomeMaster(self)).toEqual({ ok: false, reason: "bound", binding });
    expect(await roles().roleOf()).toBe("worker");
  });

  test("keeps the first master record against another identity", async () => {
    const self = { profileId: MASTER, identity: MASTER_KEY };
    await roles().becomeMaster(self);
    const other = { profileId: MASTER, identity: OTHER_KEY };
    expect(await roles().becomeMaster(other)).toEqual({
      ok: false,
      reason: "master-differs",
      record: { role: "master", ...self },
    });
  });

  test("refuses a malformed identity", async () => {
    const self = { profileId: MASTER, identity: "not an identity key" };
    expect(await roles().becomeMaster(self)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("isMasterIdentity", () => {
  test("is true only for the bound master's id and identity key, pinned as they are", async () => {
    await roles().bind(master);
    // Bound before any link: nothing proved the key yet.
    expect(await roles().isMasterIdentity(MASTER, MASTER_KEY)).toBe(false);
    await proved(MASTER, MASTER_KEY);
    expect(await roles().isMasterIdentity(MASTER, MASTER_KEY)).toBe(true);
    expect(await roles().isMasterIdentity(MASTER, OTHER_KEY)).toBe(false);
    expect(await roles().isMasterIdentity(OTHER_MASTER, MASTER_KEY)).toBe(false);
  });

  test("is false when the pin is another identity key than the binding's", async () => {
    await roles().bind(master);
    await proved(MASTER, OTHER_KEY);
    expect(await roles().isMasterIdentity(MASTER, MASTER_KEY)).toBe(false);
    expect(await roles().isMasterIdentity(MASTER, OTHER_KEY)).toBe(false);
  });

  test("stays true after the master renews its certificate under the same key", async () => {
    await roles().bind(master);
    await proved(MASTER, MASTER_KEY);
    const renewed = { identity: MASTER_KEY, fingerprint: "12:34:56" };
    expect(await pins().pin(MASTER, renewed, "pairing-code")).toMatchObject({ ok: true });
    expect(await roles().isMasterIdentity(MASTER, MASTER_KEY)).toBe(true);
    expect(await roles().record()).toEqual(binding);
  });

  test("is false on the master itself and on a template", async () => {
    await proved(MASTER, MASTER_KEY);
    await roles().becomeMaster({ profileId: MASTER, identity: MASTER_KEY });
    expect(await roles().isMasterIdentity(MASTER, MASTER_KEY)).toBe(false);
    fakeBrowser.reset();
    await proved(MASTER, MASTER_KEY);
    await roles().holdAsTemplate();
    expect(await roles().isMasterIdentity(MASTER, MASTER_KEY)).toBe(false);
  });
});

describe("the master's workers", () => {
  const worker = { profileId: LOW_WORKER, identity: OTHER_KEY, source: "pairing" } as const;
  const bound = { identity: OTHER_KEY, boundAt: NOW, source: "pairing" } as const;
  const asMaster = () => roles().becomeMaster({ profileId: MASTER, identity: MASTER_KEY });

  test("are bound only by the master, by profile id and pinned identity key", async () => {
    expect(await roles().bindWorker(worker)).toEqual({ ok: false, reason: "not-master" });
    await asMaster();
    expect(await roles().bindWorker(worker)).toEqual({ ok: true, worker: bound });
    expect(await roles().bindWorker(worker)).toEqual({ ok: true, worker: bound });
    // Bound before the first meeting: nothing proved the key yet.
    expect(await roles().isBoundWorker(LOW_WORKER, OTHER_KEY)).toBe(false);
    await proved(LOW_WORKER, OTHER_KEY);
    expect(await roles().isBoundWorker(LOW_WORKER, OTHER_KEY)).toBe(true);
    expect(await roles().isBoundWorker(LOW_WORKER, MASTER_KEY)).toBe(false);
    expect(await roles().isBoundWorker(CLONE, OTHER_KEY)).toBe(false);
  });

  test("keep the first identity key and refuse one that contradicts its pin", async () => {
    await asMaster();
    await roles().bindWorker(worker);
    const rekeyed = { ...worker, identity: MASTER_KEY };
    expect(await roles().bindWorker(rekeyed)).toEqual({
      ok: false,
      reason: "worker-differs",
      worker: bound,
    });
    await proved(CLONE, MASTER_KEY);
    const contradicted = { ...worker, profileId: CLONE };
    expect(await roles().bindWorker(contradicted)).toEqual({
      ok: false,
      reason: "pinned-different",
    });
    const malformed = { ...worker, source: "message" } as unknown as typeof worker;
    expect(await roles().bindWorker(malformed)).toEqual({ ok: false, reason: "malformed" });
  });

  test("are no workers of a worker", async () => {
    await proved(LOW_WORKER, OTHER_KEY);
    await boundWorkersRepository.set(LOW_WORKER, bound);
    await roles().bind(master);
    expect(await roles().isBoundWorker(LOW_WORKER, OTHER_KEY)).toBe(false);
  });
});

describe("template", () => {
  test("blocks every outward action from the start", async () => {
    expect(await roles().holdAsTemplate()).toEqual({ ok: true });
    expect(await roles().roleOf()).toBe("template");
    for (const action of ["announce", "discover", "work"] as const)
      expect(await roles().mayAct(action)).toBe(false);
    expect(await roles().bind(master)).toEqual({ ok: false, reason: "template" });
    const self = { profileId: MASTER, identity: MASTER_KEY };
    expect(await roles().becomeMaster(self)).toEqual({ ok: false, reason: "template" });
  });

  test("workers and the master act; a base with a role is never made a template", async () => {
    for (const action of ["announce", "discover", "work"] as const)
      expect(await roles().mayAct(action)).toBe(true);
    await roles().bind(master);
    expect(await roles().holdAsTemplate()).toEqual({ ok: false, reason: "worker" });
    expect(await roles().mayAct("work")).toBe(true);
    fakeBrowser.reset();
    await roles().becomeMaster({ profileId: MASTER, identity: MASTER_KEY });
    expect(await roles().holdAsTemplate()).toEqual({ ok: false, reason: "master" });
    expect(await roles().mayAct("announce")).toBe(true);
  });
});
