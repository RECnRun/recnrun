import { errorMessage } from "@recnrun/domain";
import * as v from "valibot";
import type { Pins } from "@/p2p/pins";
import { IdentityKeySchema } from "@/p2p/identity-key";
import { ProfileIdSchema } from "@/p2p/protocol";

const RoleSchema = v.picklist(["master", "worker", "template"]);

/** How a worker learned its master: a pairing over the local channel, the bootstrap page, or a person. */
const BindingSourceSchema = v.picklist(["pairing", "bootstrap", "manual"]);

/** A worker's master, as the local channel recorded it once; never replaced by a message. */
const BindingSchema = v.strictObject({
  role: v.literal("worker"),
  masterProfileId: ProfileIdSchema,
  masterIdentity: IdentityKeySchema,
  boundAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  source: BindingSourceSchema,
});

/** The Default's own record: its profile id and the identity key its workers pinned. */
const MasterRecordSchema = v.strictObject({
  role: v.literal("master"),
  profileId: ProfileIdSchema,
  identity: IdentityKeySchema,
});

/** A frozen base: it announces, discovers, and works for no one until P5.3's bootstrap clears it. */
const TemplateRecordSchema = v.strictObject({ role: v.literal("template") });

export const RoleRecordSchema = v.variant("role", [
  BindingSchema,
  MasterRecordSchema,
  TemplateRecordSchema,
]);

/** On the master: a worker it bound, by the identity key its first verified link pinned. */
export const BoundWorkerSchema = v.strictObject({
  identity: IdentityKeySchema,
  boundAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  source: BindingSourceSchema,
});

const MasterRequestSchema = v.strictObject({
  profileId: ProfileIdSchema,
  identity: IdentityKeySchema,
  source: BindingSourceSchema,
});

const IdentitySchema = v.strictObject({
  profileId: ProfileIdSchema,
  identity: IdentityKeySchema,
});

export type Role = v.InferOutput<typeof RoleSchema>;
type Binding = v.InferOutput<typeof BindingSchema>;
type MasterRecord = v.InferOutput<typeof MasterRecordSchema>;
type RoleRecord = v.InferOutput<typeof RoleRecordSchema>;
type BoundWorker = v.InferOutput<typeof BoundWorkerSchema>;
type PeerRequest = v.InferOutput<typeof MasterRequestSchema>;
export type MasterRequest = v.InferInput<typeof MasterRequestSchema>;
export type Identity = v.InferInput<typeof IdentitySchema>;
export type OutwardAction = "announce" | "discover" | "work";

type Malformed = { ok: false; reason: "malformed" };
type StoreFailed = { ok: false; reason: "store-failed"; error: string };
export type BindOutcome =
  | { ok: true; binding: Binding }
  | { ok: false; reason: "template" | "master" | "pinned-different" }
  | { ok: false; reason: "bound-elsewhere"; binding: Binding }
  | StoreFailed;
export type MasterOutcome =
  | { ok: true; record: MasterRecord }
  | { ok: false; reason: "template" }
  | { ok: false; reason: "bound"; binding: Binding }
  | { ok: false; reason: "master-differs"; record: MasterRecord }
  | StoreFailed;
export type WorkerOutcome =
  | { ok: true; worker: BoundWorker }
  | { ok: false; reason: "not-master" | "pinned-different" }
  | { ok: false; reason: "worker-differs"; worker: BoundWorker }
  | StoreFailed;
export type ProvisionOutcome =
  | { ok: true; binding: Binding }
  | { ok: false; reason: "not-template"; current: RoleRecord | null }
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

/** On the master: the workers it bound, keyed by profile id. */
interface WorkerStore {
  get: (profileId: string) => Promise<BoundWorker | null>;
  set: (profileId: string, worker: BoundWorker) => Promise<unknown>;
}

export interface RoleDependencies {
  role: RoleStore;
  workers: WorkerStore;
  pins: Pick<Pins, "verify">;
  now?: () => number;
}

const MAY: Record<Role, ReadonlySet<OutwardAction>> = {
  master: new Set(["announce", "discover", "work"]),
  worker: new Set(["announce", "discover", "work"]),
  template: new Set(),
};

const sameMaster = (binding: Binding, master: Identity) =>
  binding.masterProfileId === master.profileId && binding.masterIdentity === master.identity;

async function bindOnce(
  deps: RoleDependencies,
  master: PeerRequest,
  now: number,
): Promise<BindOutcome> {
  const current = await deps.role.read();
  if (current?.role === "template" || current?.role === "master")
    return { ok: false, reason: current.role };
  if (current) {
    if (sameMaster(current, master)) return { ok: true, binding: current };
    return { ok: false, reason: "bound-elsewhere", binding: current };
  }
  if ((await deps.pins.verify(master.profileId, master.identity)) === "pinned-mismatch")
    return { ok: false, reason: "pinned-different" };
  const { profileId, identity, source } = master;
  const binding: Binding = {
    role: "worker",
    masterProfileId: profileId,
    masterIdentity: identity,
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
  else if (current.profileId !== self.profileId || current.identity !== self.identity)
    return { ok: false, reason: "master-differs", record: current };
  return { ok: true, record };
}

async function holdOnce(store: RoleStore): Promise<TemplateOutcome> {
  const current = await store.read();
  if (current && current.role !== "template") return { ok: false, reason: current.role };
  if (!current) await store.write({ role: "template" });
  return { ok: true };
}

/** The clone bootstrap's one transition: a template becomes a worker of the master it names. */
async function provisionOnce(
  store: RoleStore,
  master: Identity,
  now: number,
): Promise<ProvisionOutcome> {
  const current = await store.read();
  if (current?.role !== "template") return { ok: false, reason: "not-template", current };
  const binding: Binding = {
    role: "worker",
    masterProfileId: master.profileId,
    masterIdentity: master.identity,
    boundAt: now,
    source: "bootstrap",
  };
  await store.write(binding);
  return { ok: true, binding };
}

async function bindWorkerOnce(
  deps: RoleDependencies,
  worker: PeerRequest,
  now: number,
): Promise<WorkerOutcome> {
  if ((await deps.role.read())?.role !== "master") return { ok: false, reason: "not-master" };
  const bound = await deps.workers.get(worker.profileId);
  if (bound?.identity === worker.identity) return { ok: true, worker: bound };
  if (bound) return { ok: false, reason: "worker-differs", worker: bound };
  if ((await deps.pins.verify(worker.profileId, worker.identity)) === "pinned-mismatch")
    return { ok: false, reason: "pinned-different" };
  const { identity, source } = worker;
  const record: BoundWorker = { identity, boundAt: now, source };
  await deps.workers.set(worker.profileId, record);
  return { ok: true, worker: record };
}

const pinMatches = async (deps: RoleDependencies, peer: Identity) =>
  (await deps.pins.verify(peer.profileId, peer.identity)) === "pinned-match";

/** The bound master's id and identity key, as the pin a verified link made holds them. */
async function provesMaster(deps: RoleDependencies, current: RoleRecord | null, peer: Identity) {
  if (current?.role !== "worker" || !sameMaster(current, peer)) return false;
  return pinMatches(deps, peer);
}

/** On the master: a worker it bound, with the identity key it bound and pinned. */
async function provesWorker(deps: RoleDependencies, current: RoleRecord | null, peer: Identity) {
  if (current?.role !== "master") return false;
  if ((await deps.workers.get(peer.profileId))?.identity !== peer.identity) return false;
  return pinMatches(deps, peer);
}

const storeFailed = (error: unknown): StoreFailed => ({
  ok: false,
  reason: "store-failed",
  error: errorMessage(error),
});

/** Runs each piece of work after the one before it has settled. */
function serialQueue() {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  };
}

/**
 * The hierarchy as this profile recorded it: the Default is the master, a worker keeps the one
 * master it was bound to, and a template does nothing outward. No message, presence, directory
 * name, or profile id order changes it; only the local channel and the clone bootstrap write it.
 */
export function createRoles(deps: RoleDependencies) {
  const now = deps.now ?? Date.now;
  // Each change reads before it writes, so two at once would otherwise both see no role.
  const serial = serialQueue();
  const change = <T, R>(
    schema: v.GenericSchema<unknown, T>,
    input: unknown,
    work: (request: T) => Promise<R>,
  ): Promise<R | Malformed | StoreFailed> => {
    const request = v.safeParse(schema, input);
    if (!request.success) return Promise.resolve({ ok: false, reason: "malformed" });
    return serial(() => work(request.output)).catch(storeFailed);
  };
  const record = () => serial(() => deps.role.read());
  const roleOf = async (): Promise<Role> => (await record())?.role ?? "worker";
  // An unreadable role or pin proves nothing and permits nothing: fail closed.
  const proves =
    (check: typeof provesMaster) =>
    (profileId: string, identity: string): Promise<boolean> =>
      record()
        .then((current) => check(deps, current, { profileId, identity }))
        .catch(() => false);
  const isBoundWorker = proves(provesWorker);
  return {
    roleOf,
    record,
    bind: (master: MasterRequest) =>
      change(MasterRequestSchema, master, (request) => bindOnce(deps, request, now())),
    becomeMaster: (self: Identity) =>
      change(IdentitySchema, self, (request) => becomeMasterOnce(deps.role, request)),
    holdAsTemplate: () => serial(() => holdOnce(deps.role)).catch(storeFailed),
    provision: (master: Identity) =>
      change(IdentitySchema, master, (request) => provisionOnce(deps.role, request, now())),
    bindWorker: (worker: MasterRequest) =>
      change(MasterRequestSchema, worker, (request) => bindWorkerOnce(deps, request, now())),
    mayAct: (action: OutwardAction) =>
      roleOf().then(
        (role) => MAY[role].has(action),
        () => false,
      ),
    isMasterIdentity: proves(provesMaster),
    isBoundWorker,
    /** The master controls itself and each worker it bound; a worker or a template, only itself. */
    controls: async (profileId: string, self: string): Promise<boolean> => {
      if (profileId === self) return true;
      const worker = await deps.workers.get(profileId).catch(() => null);
      return worker !== null && isBoundWorker(profileId, worker.identity);
    },
  };
}

export type Roles = ReturnType<typeof createRoles>;
