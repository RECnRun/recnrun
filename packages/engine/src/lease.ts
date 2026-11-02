import type { ControlState, Lease, LeaseFence, LeaseHolderKind } from "@recnrun/protocol";
import { controlTransition } from "./machines.ts";

export interface LeaseHolder {
  id: string;
  kind: LeaseHolderKind;
}

/** `stale-lease`: the fence is not the target's live lease; `lease-held`: someone else controls it. */
export type LeaseError =
  | {
      code: "stale-lease";
      targetId: string;
      fencingToken: number;
      currentFencingToken: number | null;
    }
  | { code: "lease-held"; targetId: string; holderId: string; expiresAt: number };

export type LeaseResult = { ok: true; lease: Lease } | { ok: false; error: LeaseError };

export interface LeaseRegistryOptions {
  /** Milliseconds since the epoch; injected so the registry holds no timer. */
  now: () => number;
  ttlMs: number;
}

/** Exclusive control per target, fenced by a token that only grows for that target. */
export interface LeaseRegistry {
  /** Grants a free target; a held one stays held until its holder releases it or it expires. */
  acquire(targetId: string, holder: LeaseHolder): LeaseResult;
  /** A person takes control at once from an agent or a replay; their fence turns stale. */
  takeControl(targetId: string, holderId: string): LeaseResult;
  heartbeat(targetId: string, fence: LeaseFence): LeaseResult;
  release(targetId: string, fence: LeaseFence): LeaseResult;
  /** Checks the fence a controlled command carries. */
  authorize(targetId: string, fence: LeaseFence): LeaseResult;
  current(targetId: string): Lease | undefined;
  control(targetId: string): ControlState;
  /** Expires every lease past `now` and returns each expired lease once. */
  tick(now: number): Lease[];
}

interface Registry extends LeaseRegistryOptions {
  leases: Map<string, Lease>;
  tokens: Map<string, number>;
  expired: Lease[];
}

function sweep(registry: Registry, targetId: string, at: number): void {
  const lease = registry.leases.get(targetId);
  if (lease === undefined || lease.expiresAt > at) return;
  registry.leases.delete(targetId);
  registry.expired.push(lease);
}

function live(registry: Registry, targetId: string): Lease | undefined {
  sweep(registry, targetId, registry.now());
  return registry.leases.get(targetId);
}

function grant(registry: Registry, targetId: string, holder: LeaseHolder): LeaseResult {
  const fencingToken = (registry.tokens.get(targetId) ?? 0) + 1;
  registry.tokens.set(targetId, fencingToken);
  const acquiredAt = registry.now();
  const lease: Lease = {
    leaseId: `${targetId}/${fencingToken}`,
    targetId,
    holderId: holder.id,
    kind: holder.kind,
    fencingToken,
    acquiredAt,
    expiresAt: acquiredAt + registry.ttlMs,
  };
  registry.leases.set(targetId, lease);
  return { ok: true, lease };
}

function held({ targetId, holderId, expiresAt }: Lease): LeaseResult {
  return { ok: false, error: { code: "lease-held", targetId, holderId, expiresAt } };
}

function authorize(registry: Registry, targetId: string, fence: LeaseFence): LeaseResult {
  const lease = live(registry, targetId);
  if (lease?.leaseId === fence.leaseId && lease.fencingToken === fence.fencingToken) {
    return { ok: true, lease };
  }
  const currentFencingToken = lease?.fencingToken ?? null;
  const { fencingToken } = fence;
  return { ok: false, error: { code: "stale-lease", targetId, fencingToken, currentFencingToken } };
}

function heartbeat(registry: Registry, targetId: string, fence: LeaseFence): LeaseResult {
  const result = authorize(registry, targetId, fence);
  if (!result.ok) return result;
  const lease = { ...result.lease, expiresAt: registry.now() + registry.ttlMs };
  registry.leases.set(targetId, lease);
  return { ok: true, lease };
}

export function createLeaseRegistry(options: LeaseRegistryOptions): LeaseRegistry {
  const registry: Registry = { ...options, leases: new Map(), tokens: new Map(), expired: [] };
  return {
    acquire(targetId, holder) {
      const lease = live(registry, targetId);
      return lease ? held(lease) : grant(registry, targetId, holder);
    },
    takeControl(targetId, holderId) {
      const lease = live(registry, targetId);
      // The control machine lets a person take over from an agent or a replay, never from a person.
      if (lease && !controlTransition(lease.kind, "takeControl").ok) return held(lease);
      return grant(registry, targetId, { id: holderId, kind: "manual" });
    },
    heartbeat: (targetId, fence) => heartbeat(registry, targetId, fence),
    release(targetId, fence) {
      const result = authorize(registry, targetId, fence);
      if (result.ok) registry.leases.delete(targetId);
      return result;
    },
    authorize: (targetId, fence) => authorize(registry, targetId, fence),
    current: (targetId) => live(registry, targetId),
    control: (targetId) => live(registry, targetId)?.kind ?? "unassigned",
    tick(now) {
      // Deleting the entry being visited is safe while iterating a Map.
      for (const targetId of registry.leases.keys()) sweep(registry, targetId, now);
      return registry.expired.splice(0);
    },
  };
}
