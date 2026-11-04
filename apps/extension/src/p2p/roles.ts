import { errorMessage } from "@recnrun/domain";
import * as v from "valibot";
import type { Pins } from "@/p2p/pins";
import { FingerprintSchema, ProfileIdSchema } from "@/p2p/protocol";

const RoleSchema = v.picklist(["master", "worker", "template"]);

/** How a worker learned its master: a pairing over the local channel, the bootstrap page, or a person. */
const BindingSourceSchema = v.picklist(["pairing", "bootstrap", "manual"]);

/** A worker's master, as the local channel recorded it once; never replaced by a message. */
const BindingSchema = v.strictObject({
  role: v.literal("worker"),
  masterProfileId: ProfileIdSchema,
  masterFingerprint: FingerprintSchema,
  boundAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  source: BindingSourceSchema,
});

/** The Default's own record: its identity and the certificate its workers pinned. */
const MasterRecordSchema = v.strictObject({
  role: v.literal("master"),
  profileId: ProfileIdSchema,
  fingerprint: FingerprintSchema,
});

/** A frozen base: it announces, discovers, and works for no one until P5.3's bootstrap clears it. */
const TemplateRecordSchema = v.strictObject({ role: v.literal("template") });

export const RoleRecordSchema = v.variant("role", [
  BindingSchema,
  MasterRecordSchema,
  TemplateRecordSchema,
]);

const MasterRequestSchema = v.strictObject({
  profileId: ProfileIdSchema,
  fingerprint: FingerprintSchema,
  source: BindingSourceSchema,
});

const IdentitySchema = v.strictObject({
  profileId: ProfileIdSchema,
  fingerprint: FingerprintSchema,
});

export type Role = v.InferOutput<typeof RoleSchema>;
export type Binding = v.InferOutput<typeof BindingSchema>;
type MasterRecord = v.InferOutput<typeof MasterRecordSchema>;
type RoleRecord = v.InferOutput<typeof RoleRecordSchema>;
export type MasterRequest = v.InferInput<typeof MasterRequestSchema>;
export type Identity = v.InferInput<typeof IdentitySchema>;
export type OutwardAction = "announce" | "discover" | "work";

type StoreFailed = { ok: false; reason: "store-failed"; error: string };
export type BindOutcome =
  | { ok: true; binding: Binding }
  | { ok: false; reason: "malformed" | "template" | "master" | "pinned-different" }
  | { ok: false; reason: "bound-elsewhere"; binding: Binding }
  | StoreFailed;
export type MasterOutcome =
  | { ok: true; record: MasterRecord }
  | { ok: false; reason: "malformed" | "template" }
  | { ok: false; reason: "bound"; binding: Binding }
  | { ok: false; reason: "master-differs"; record: MasterRecord }
  | StoreFailed;
export type TemplateOutcome =
  | { ok: true }
  | { ok: false; reason: "master" | "worker" }
  | StoreFailed;

/** Where the role lives; the storage boundary validates it. */
interface RoleStore {
  read: () => Promise<RoleRecord | null>;
  write: (value: RoleRecord | null) => Promise<unknown>;
}

export interface RoleDependencies {
  role: RoleStore;
  pins: Pick<Pins, "verify">;
  now?: () => number;
}

const MAY: Record<Role, ReadonlySet<OutwardAction>> = {
  master: new Set(["announce", "discover", "work"]),
  worker: new Set(["announce", "discover", "work"]),
  template: new Set(),
};

const sameMaster = (binding: Binding, master: Identity) =>
  binding.masterProfileId === master.profileId && binding.masterFingerprint === master.fingerprint;

async function bindOnce(
  deps: RoleDependencies,
  master: v.InferOutput<typeof MasterRequestSchema>,
  now: number,
): Promise<BindOutcome> {
  const current = await deps.role.read();
  if (current?.role === "template" || current?.role === "master")
    return { ok: false, reason: current.role };
  if (current) {
    if (sameMaster(current, master)) return { ok: true, binding: current };
    return { ok: false, reason: "bound-elsewhere", binding: current };
  }
  if ((await deps.pins.verify(master.profileId, master.fingerprint)) === "pinned-mismatch")
    return { ok: false, reason: "pinned-different" };
  const { profileId, fingerprint, source } = master;
  const binding: Binding = {
    role: "worker",
    masterProfileId: profileId,
    masterFingerprint: fingerprint,
    boundAt: now,
    source,
  };
  await deps.role.write(binding);
  return { ok: true, binding };
}

async function becomeMasterOnce(store: RoleStore, self: Identity): Promise<MasterOutcome> {
  const current = await store.read();
  if (current?.role === "template") return { ok: false, reason: "template" };
  if (current?.role === "worker") return { ok: false, reason: "bound", binding: current };
  const record: MasterRecord = { role: "master", ...self };
  if (!current) await store.write(record);
  else if (current.profileId !== self.profileId || current.fingerprint !== self.fingerprint)
    return { ok: false, reason: "master-differs", record: current };
  return { ok: true, record };
}

async function holdOnce(store: RoleStore): Promise<TemplateOutcome> {
  const current = await store.read();
  if (current && current.role !== "template") return { ok: false, reason: current.role };
  if (!current) await store.write({ role: "template" });
  return { ok: true };
}

const storeFailed = (error: unknown): StoreFailed => ({
  ok: false,
  reason: "store-failed",
  error: errorMessage(error),
});

/**
 * The hierarchy as this profile recorded it: the Default is the master, a worker keeps the one
 * master it was bound to, and a template does nothing outward. No message, presence, directory
 * name, or profile id order changes it; only the local channel writes it.
 */
export function createRoles(deps: RoleDependencies) {
  const now = deps.now ?? Date.now;
  let queue: Promise<unknown> = Promise.resolve();
  // Each change reads before it writes, so two at once would otherwise both see no role.
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  };
  const record = () => serial(() => deps.role.read());
  const roleOf = async (): Promise<Role> => (await record())?.role ?? "worker";
  const bind = (master: MasterRequest): Promise<BindOutcome> => {
    const request = v.safeParse(MasterRequestSchema, master);
    if (!request.success) return Promise.resolve({ ok: false, reason: "malformed" });
    return serial(() => bindOnce(deps, request.output, now())).catch(storeFailed);
  };
  const becomeMaster = (self: Identity): Promise<MasterOutcome> => {
    const request = v.safeParse(IdentitySchema, self);
    if (!request.success) return Promise.resolve({ ok: false, reason: "malformed" });
    return serial(() => becomeMasterOnce(deps.role, request.output)).catch(storeFailed);
  };
  const holdAsTemplate = () => serial(() => holdOnce(deps.role)).catch(storeFailed);
  // An unreadable role is no role to act on: fail closed.
  const mayAct = (action: OutwardAction) =>
    roleOf().then(
      (role) => MAY[role].has(action),
      () => false,
    );
  /** True only for the bound master's id and certificate, as the pin a verified link made holds them. */
  const isMasterIdentity = async (profileId: string, fingerprint: string) => {
    const current = await record();
    if (current?.role !== "worker" || !sameMaster(current, { profileId, fingerprint }))
      return false;
    return (await deps.pins.verify(profileId, fingerprint)) === "pinned-match";
  };
  return {
    roleOf,
    record,
    bind,
    becomeMaster,
    holdAsTemplate,
    mayAct,
    // An unreadable role or pin proves no master: fail closed.
    isMasterIdentity: (profileId: string, fingerprint: string) =>
      isMasterIdentity(profileId, fingerprint).catch(() => false),
  };
}
