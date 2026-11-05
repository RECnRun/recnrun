import { errorMessage } from "@recnrun/domain";
import * as v from "valibot";
import type { BackgroundReply } from "@/messaging/background-reply";
import { cloneRequestOfPage } from "@/messaging/clone-fragment";
import { PocProvisionCloneSchema } from "@/messaging/poc-presence";
import type { AckClone, CloneRequest } from "@/messaging/poc-presence";
import type { IdentityStatement } from "@/p2p/identity-key";
import type { Roles } from "@/p2p/roles";
import type { ProfileIdentity } from "@/storage/peer-repository";

export type { CloneRequest };

/*
 * P5.3 (POC PLAN.md): a copied base starts as a template and becomes the instance the launcher
 * named only through its own bootstrap page: it drops the base's key, certificate, and peers,
 * takes the instance's id and namespace, binds the master, makes its own key and certificate,
 * acks, and only then announces. The role change is the last write, after the ack, so an
 * interrupted run is still a template (which announces nothing) and starts over, and a finished
 * one answers again unchanged.
 */

export interface ProvisionDependencies {
  roles: Pick<Roles, "record" | "provision">;
  identity: {
    read(): Promise<ProfileIdentity | null>;
    write(value: ProfileIdentity): Promise<unknown>;
  };
  namespace: { read(): Promise<unknown>; write(value: string): Promise<unknown> };
  /** Forgets the identity key and certificate, closing whatever document still holds them. */
  discard(): Promise<void>;
  clearTransient(): Promise<void>;
  adoptBoot(token: string): Promise<void>;
  /** This profile's statement for `profileId`, making the key and certificate if there are none. */
  statement(profileId: string): Promise<IdentityStatement>;
  ack(token: string, identity: IdentityStatement, clone: AckClone): Promise<void>;
  /** Starts announcing, discovering, and pairing, once. */
  start(): Promise<void>;
}

type Bound = Extract<Awaited<ReturnType<Roles["record"]>>, { role: "worker" }>;

/** Why a provisioned profile is not the instance `request` names, or undefined if it is. */
function conflictOf(
  bound: Bound,
  self: ProfileIdentity | null,
  namespace: unknown,
  request: CloneRequest,
) {
  if (bound.masterProfileId !== request.masterProfileId)
    return `bound to the master ${bound.masterProfileId}`;
  if (bound.masterIdentity !== request.masterIdentity) return "bound to another master key";
  if (self?.profileId !== request.instanceId) return `provisioned as ${self?.profileId}`;
  if (namespace !== request.namespace) return `provisioned in the namespace ${String(namespace)}`;
  return undefined;
}

const displayNameOf = (profileId: string) => `Profile ${profileId.slice(0, 4).toUpperCase()}`;

async function provisionTemplate(deps: ProvisionDependencies, request: CloneRequest) {
  await deps.discard();
  await deps.clearTransient();
  const { instanceId } = request;
  await deps.identity.write({ profileId: instanceId, displayName: displayNameOf(instanceId) });
  await deps.namespace.write(request.namespace);
}

async function commitRole(deps: ProvisionDependencies, request: CloneRequest) {
  const master = { profileId: request.masterProfileId, identity: request.masterIdentity };
  const provisioned = await deps.roles.provision(master);
  if (!provisioned.ok) throw new Error(`The role was not provisioned: ${provisioned.reason}.`);
}

/** Provisions the template, or answers again for the same instance; anything else is refused. */
export async function provisionClone(
  deps: ProvisionDependencies,
  request: CloneRequest,
): Promise<void> {
  const current = await deps.roles.record();
  const fresh = current?.role === "template";
  if (fresh) await provisionTemplate(deps, request);
  else if (current?.role === "worker") {
    const [self, namespace] = await Promise.all([deps.identity.read(), deps.namespace.read()]);
    const conflict = conflictOf(current, self, namespace, request);
    if (conflict) throw new Error(`conflicting identity: ${conflict}; nothing changed.`);
  } else {
    const role = current?.role ?? "unassigned";
    throw new Error(`conflicting identity: this profile is ${role}, no template; nothing changed.`);
  }
  await deps.adoptBoot(request.token);
  const { instanceId, operationId } = request;
  const identity = await deps.statement(instanceId);
  await deps.ack(request.token, identity, { instanceId, operationId, provisioned: true });
  if (fresh) await commitRole(deps, request);
  await deps.start();
}

interface Sender {
  id?: string;
  url?: string;
}

/** Only the launcher's clone bootstrap page, and only for the request its own address names, may ask. */
export function createProvisionListener(
  provision: (request: CloneRequest) => Promise<void>,
  own: { extensionId: string; extensionUrl: string },
) {
  let queue: Promise<unknown> = Promise.resolve();
  return (message: unknown, sender: Sender, reply: (answer: BackgroundReply) => void) => {
    const parsed = v.safeParse(PocProvisionCloneSchema, message);
    if (!parsed.success || sender.id !== own.extensionId) return false;
    const { type: _type, ...request } = parsed.output;
    const named = cloneRequestOfPage(sender.url, own.extensionUrl);
    if (!named || JSON.stringify(named) !== JSON.stringify(request)) return false;
    // One at a time: a second run would otherwise discard the key the first just made.
    const next = queue.then(() => provision(request));
    queue = next.catch(() => {});
    next.then(
      () => reply({ ok: true }),
      (error: unknown) => reply({ ok: false, error: errorMessage(error) }),
    );
    return true;
  };
}
