import * as v from "valibot";
import { beforeEach, describe, expect, test } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { RoleRecordSchema, createRoles } from "@/p2p/roles";
import {
  MASTER,
  MASTER_KEY,
  NOW,
  binding,
  boundWorkersRepository,
  master,
  pins,
  proved,
  roles,
} from "./role-fixture";

beforeEach(() => {
  fakeBrowser.reset();
});

describe("the stored record", () => {
  test("the binding survives a reload of the store", async () => {
    await proved(MASTER, MASTER_KEY);
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
    expect(await reloaded.isMasterIdentity(MASTER, MASTER_KEY)).toBe(true);
  });

  test("an unreadable store binds nothing and proves no master", async () => {
    const broken = {
      read: () => Promise.reject(new Error("The stored local:role does not match its schema.")),
      write: () => Promise.reject(new Error("quota")),
    };
    const workers = boundWorkersRepository;
    const failing = createRoles({ role: broken, workers, pins: pins(), now: () => NOW });
    expect(await failing.bind(master)).toEqual({
      ok: false,
      reason: "store-failed",
      error: "The stored local:role does not match its schema.",
    });
    await proved(MASTER, MASTER_KEY);
    expect(await failing.isMasterIdentity(MASTER, MASTER_KEY)).toBe(false);
    expect(await failing.mayAct("announce")).toBe(false);
  });

  test("refuses a stored role that carries anything else", () => {
    expect(v.is(RoleRecordSchema, binding)).toBe(true);
    expect(v.is(RoleRecordSchema, { ...binding, displayName: "Default" })).toBe(false);
    expect(v.is(RoleRecordSchema, { role: "template", masterProfileId: MASTER })).toBe(false);
    expect(v.is(RoleRecordSchema, { role: "controller" })).toBe(false);
  });
});

describe("provisioning a template", () => {
  const masterOf = { profileId: MASTER, identity: MASTER_KEY };
  const provisioned = { ...binding, source: "bootstrap" };

  test("turns the template into a worker of that master, in one change", async () => {
    await roles().holdAsTemplate();
    expect(await roles().provision(masterOf)).toEqual({ ok: true, binding: provisioned });
    expect(await roles().record()).toEqual(provisioned);
    expect(await roles().mayAct("announce")).toBe(true);
  });

  test("refuses anything but a template, which bind keeps refusing", async () => {
    expect(await roles().provision(masterOf)).toEqual({
      ok: false,
      reason: "not-template",
      current: null,
    });
    await roles().holdAsTemplate();
    expect(await roles().bind(master)).toEqual({ ok: false, reason: "template" });
    await roles().provision(masterOf);
    expect(await roles().provision(masterOf)).toEqual({
      ok: false,
      reason: "not-template",
      current: provisioned,
    });
    const malformed = { profileId: MASTER, identity: "short" };
    expect(await roles().provision(malformed)).toEqual({ ok: false, reason: "malformed" });
  });
});
