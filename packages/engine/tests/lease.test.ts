import { expect, test } from "vite-plus/test";
import type { Lease, LeaseFence } from "@recnrun/protocol";
import { createLeaseRegistry, type LeaseHolder, type LeaseResult } from "../src/index.ts";

const agent: LeaseHolder = { id: "agent-1", kind: "agent" };
const runner: LeaseHolder = { id: "runner-1", kind: "replay" };
const ana: LeaseHolder = { id: "ana", kind: "manual" };

function setup(ttlMs = 1000) {
  const clock = { now: 0 };
  const leases = createLeaseRegistry({ now: () => clock.now, ttlMs });
  const advance = (ms: number): number => (clock.now += ms);
  return { leases, advance };
}

function granted(result: LeaseResult): Lease {
  if (!result.ok) throw new Error(`expected a lease, got ${result.error.code}`);
  return result.lease;
}

const fence = ({ leaseId, fencingToken }: Lease): LeaseFence => ({ leaseId, fencingToken });

test("a delayed command from a previous lease is stale once another holder re-acquires", () => {
  const { leases, advance } = setup();
  const first = granted(leases.acquire("T1", agent));
  expect(first).toEqual({
    leaseId: "T1/1",
    targetId: "T1",
    holderId: "agent-1",
    kind: "agent",
    fencingToken: 1,
    acquiredAt: 0,
    expiresAt: 1000,
  });

  expect(leases.tick(advance(1000))).toEqual([first]);
  const second = granted(leases.acquire("T1", runner));
  expect(second.fencingToken).toBe(2);

  expect(leases.authorize("T1", fence(first))).toEqual({
    ok: false,
    error: { code: "stale-lease", targetId: "T1", fencingToken: 1, currentFencingToken: 2 },
  });
  expect(leases.authorize("T1", fence(second))).toEqual({ ok: true, lease: second });
});

test("another holder acquires only after expiry", () => {
  const { leases, advance } = setup();
  const first = granted(leases.acquire("T1", agent));
  advance(999);
  expect(leases.acquire("T1", runner)).toEqual({
    ok: false,
    error: { code: "lease-held", targetId: "T1", holderId: "agent-1", expiresAt: 1000 },
  });
  expect(leases.acquire("T1", agent).ok, "the holder heartbeats instead").toBe(false);
  expect(leases.authorize("T1", fence(first)).ok).toBe(true);
  advance(1);
  expect(granted(leases.acquire("T1", runner)).holderId).toBe("runner-1");
});

test("an expired lease authorizes nothing even before tick runs", () => {
  const { leases, advance } = setup();
  const first = granted(leases.acquire("T1", agent));
  advance(1000);
  expect(leases.authorize("T1", fence(first))).toEqual({
    ok: false,
    error: { code: "stale-lease", targetId: "T1", fencingToken: 1, currentFencingToken: null },
  });
  expect(leases.control("T1")).toBe("unassigned");
  expect(leases.tick(1000), "tick still reports the expiry once").toEqual([first]);
  expect(leases.tick(1000)).toEqual([]);
});

test("a heartbeat extends the lease from now", () => {
  const { leases, advance } = setup();
  const first = granted(leases.acquire("T1", agent));
  advance(800);
  const extended = granted(leases.heartbeat("T1", fence(first)));
  expect(extended).toEqual({ ...first, expiresAt: 1800 });
  expect(leases.tick(advance(900))).toEqual([]);
  expect(leases.authorize("T1", fence(first)).ok).toBe(true);
  expect(leases.tick(advance(100))).toEqual([extended]);
  expect(leases.heartbeat("T1", fence(first)).ok, "a heartbeat cannot revive it").toBe(false);
});

test("release frees the target at once and the released token stays stale", () => {
  const { leases } = setup();
  const first = granted(leases.acquire("T1", agent));
  expect(leases.release("T1", fence(first))).toEqual({ ok: true, lease: first });
  expect(leases.control("T1")).toBe("unassigned");
  expect(leases.current("T1")).toBeUndefined();
  expect(leases.release("T1", fence(first)).ok).toBe(false);
  const second = granted(leases.acquire("T1", runner));
  expect(second.fencingToken).toBe(2);
  expect(leases.authorize("T1", fence(first)).ok).toBe(false);
});

test("a fence with the right token but another lease id is stale", () => {
  const { leases } = setup();
  const first = granted(leases.acquire("T1", agent));
  const forged = { leaseId: "T2/1", fencingToken: first.fencingToken };
  expect(leases.authorize("T1", forged).ok).toBe(false);
});

test("a person takes control from an agent at once, and the agent's token turns stale", () => {
  const { leases, advance } = setup();
  const agentLease = granted(leases.acquire("T1", agent));
  advance(10);
  const manual = granted(leases.takeControl("T1", "ana"));
  expect(manual).toMatchObject({ holderId: "ana", kind: "manual", fencingToken: 2 });
  expect(leases.control("T1")).toBe("manual");
  expect(leases.authorize("T1", fence(agentLease)).ok).toBe(false);
  expect(leases.heartbeat("T1", fence(agentLease)).ok).toBe(false);
});

test("taking control of a free target acquires it; nobody takes it from a person", () => {
  const { leases } = setup();
  const manual = granted(leases.takeControl("T1", "ana"));
  expect(manual.kind).toBe("manual");
  expect(leases.takeControl("T1", "bob")).toEqual({
    ok: false,
    error: { code: "lease-held", targetId: "T1", holderId: "ana", expiresAt: 1000 },
  });
  expect(leases.acquire("T1", agent).ok).toBe(false);
});

test("fencing tokens increase per target", () => {
  const { leases } = setup();
  expect(granted(leases.acquire("T1", agent)).fencingToken).toBe(1);
  expect(granted(leases.acquire("T2", ana)).fencingToken).toBe(1);
  expect(leases.control("T1")).toBe("agent");
  expect(leases.control("T2")).toBe("manual");
  expect(leases.control("T3")).toBe("unassigned");
});

test("tick expires every lease past its expiry and reports each once", () => {
  const { leases, advance } = setup();
  const t1 = granted(leases.acquire("T1", agent));
  advance(500);
  const t2 = granted(leases.acquire("T2", runner));
  expect(leases.tick(1000)).toEqual([t1]);
  expect(leases.tick(1500)).toEqual([t2]);
  expect(leases.tick(5000)).toEqual([]);
});
