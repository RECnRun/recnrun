import * as v from "valibot";
import { NonEmptyStringSchema } from "./common.ts";

/** Increases with every lease granted on a target, so a command from an older lease is fenced off. */
export const FencingTokenSchema = v.pipe(v.number(), v.integer(), v.minValue(1));

/** Milliseconds since the Unix epoch, as the engine's injected clock reports them. */
export const EpochMsSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

/** Who may hold a lease: control states other than `unassigned`. */
export const LEASE_HOLDER_KINDS = ["manual", "agent", "replay"] as const;

/** What a controlled command carries so the engine can reject one from a previous lease. */
export const LeaseFenceSchema = v.strictObject({
  leaseId: NonEmptyStringSchema,
  fencingToken: FencingTokenSchema,
});

/** Exclusive control of one target; a heartbeat moves `expiresAt`, expiry releases it. */
export const LeaseSchema = v.strictObject({
  ...LeaseFenceSchema.entries,
  targetId: NonEmptyStringSchema,
  holderId: NonEmptyStringSchema,
  kind: v.picklist(LEASE_HOLDER_KINDS),
  acquiredAt: EpochMsSchema,
  expiresAt: EpochMsSchema,
});

export type LeaseFence = v.InferOutput<typeof LeaseFenceSchema>;
export type Lease = v.InferOutput<typeof LeaseSchema>;
export type LeaseHolderKind = (typeof LEASE_HOLDER_KINDS)[number];
