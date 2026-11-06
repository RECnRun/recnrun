import { errorMessage } from "@recnrun/domain";
import * as v from "valibot";
import { downloadsWriter } from "@/background/downloads-publisher";
import type { WriterPort } from "@/background/downloads-publisher";
import type { BackgroundReply } from "@/messaging/background-reply";
import {
  BOOTSTRAP_STEPS,
  PocLauncherAckSchema,
  PocLauncherFailureSchema,
} from "@/messaging/poc-presence";
import type { BootstrapStep } from "@/messaging/poc-presence";
import type { AckClone, AckTemplate } from "@/messaging/poc-presence";
import { TokenSchema, ackPath } from "@/p2p/downloads-rendezvous";
import { IdentityStatementSchema } from "@/p2p/identity-key";
import type { IdentityStatement } from "@/p2p/identity-key";
import { SettingSchema } from "@/p2p/poc-setting";
import { ProfileIdSchema } from "@/p2p/protocol";
import type { Identity } from "@/p2p/roles";

/*
 * P4.3 (POC PLAN.md decision 11): the launcher's proof that an open attempt reached a profile. A
 * presence alone is not one: a running profile keeps its boot, so the presence names neither the
 * attempt nor whether it answers this one.
 */

/** The keys follow this order in the file, which is what the launcher reads. */
const AckSchema = v.strictObject({
  token: TokenSchema,
  profileId: ProfileIdSchema,
  // Absent only from a template's ack: a template holds no working key or certificate (P5.3).
  identity: v.optional(IdentityStatementSchema),
  boot: v.pipe(v.string(), v.uuid()),
  createdAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  // A template base's ack names the base; the launcher reads these two after the others.
  template: v.optional(v.literal(true)),
  setting: v.optional(SettingSchema),
  // A provisioned clone's ack names the instance and the operation it answers (P5.3).
  instanceId: v.optional(TokenSchema),
  operationId: v.optional(TokenSchema),
  provisioned: v.optional(v.literal(true)),
});

// open.sh logs the error, so it reads only this alphabet, 1 to 200 characters.
const SAFE_ERROR = /^[A-Za-z0-9 .,:;()_/=-]{1,200}$/;

/** The failure ack of a bootstrap that cannot write its ack: no identity, so no presence is needed. */
const FailureAckSchema = v.strictObject({
  token: TokenSchema,
  profileId: ProfileIdSchema,
  failedStep: v.picklist(BOOTSTRAP_STEPS),
  error: v.pipe(v.string(), v.regex(SAFE_ERROR)),
  createdAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

/** Any text in the alphabet of the failure ack: other characters become spaces. */
export function boundedError(text: string): string {
  const safe = text
    .replaceAll(/[^A-Za-z0-9 .,:;()_/=-]/g, " ")
    .replaceAll(/ {2,}/g, " ")
    .trim();
  return safe.slice(0, 200).trim() || "unknown error";
}

export type FailureDependencies = Pick<
  AckDependencies,
  "downloads" | "profileId" | "namespace" | "now"
>;

/** Writes where the ack would go, saying the bootstrap failed at `step`; it needs no presence. */
export async function writeFailureAck(
  deps: FailureDependencies,
  token: string,
  step: BootstrapStep,
  error: string,
): Promise<void> {
  const profileId = await deps.profileId();
  const path = ackPath(await deps.namespace(), profileId, token);
  const ack = v.parse(FailureAckSchema, {
    token,
    profileId,
    failedStep: step,
    error: boundedError(error),
    createdAt: (deps.now ?? Date.now)(),
  });
  await downloadsWriter(deps.downloads).write(path, JSON.stringify(ack));
}

export interface AckDependencies {
  downloads: WriterPort;
  profileId: () => Promise<string>;
  /** The statement of the presence published last, or undefined before the first one. */
  identity: () => Promise<IdentityStatement | undefined>;
  namespace: () => Promise<string>;
  /** The session's current boot, which equals the token only on a fresh start. */
  boot: () => Promise<string>;
  now?: () => number;
}

/** Writes the ack of one attempt under this profile's own folder, replacing an earlier one. */
export async function writeAck(
  deps: AckDependencies,
  token: string,
  extra?: AckTemplate | AckClone,
): Promise<void> {
  const template = extra !== undefined && "template" in extra;
  const identity = template ? undefined : await deps.identity();
  if (!template && !identity) throw new Error("No presence has been published yet.");
  const profileId = await deps.profileId();
  const path = ackPath(await deps.namespace(), profileId, token);
  const ack = v.parse(AckSchema, {
    token,
    profileId,
    ...(identity && { identity }),
    boot: await deps.boot(),
    createdAt: (deps.now ?? Date.now)(),
    ...extra,
  });
  const text = JSON.stringify(ack);
  await downloadsWriter(deps.downloads).write(path, text);
}

interface Sender {
  id?: string;
  url?: string;
}

/** Records this profile as the master with the key of its presence; any other outcome throws. */
export async function claimMaster(
  roles: { becomeMaster: (self: Identity) => Promise<{ ok: boolean; reason?: string }> },
  deps: Pick<AckDependencies, "profileId" | "identity">,
): Promise<void> {
  const statement = await deps.identity();
  if (!statement) throw new Error("No presence has been published yet.");
  const outcome = await roles.becomeMaster({
    profileId: await deps.profileId(),
    identity: statement.key,
  });
  if (!outcome.ok) throw new Error(`This profile cannot become the master: ${outcome.reason}`);
}

/** The bootstrap page asks, once the presence is out, for the ack of the token it was opened with. */
export function createAckListener(
  ack: (token: string, template?: AckTemplate, master?: true) => Promise<void>,
  own: { extensionId: string; extensionUrl: string },
) {
  return (message: unknown, sender: Sender, reply: (answer: BackgroundReply) => void) => {
    const ownPage = sender.id === own.extensionId && sender.url?.startsWith(own.extensionUrl);
    const parsed = v.safeParse(PocLauncherAckSchema, message);
    if (!parsed.success || !ownPage) return false;
    const { token, ...rest } = parsed.output;
    let sent: Promise<void>;
    if ("template" in rest) sent = ack(token, { template: rest.template, setting: rest.setting });
    else if ("master" in rest) sent = ack(token, undefined, true);
    else sent = ack(token);
    sent.then(
      () => reply({ ok: true }),
      (error: unknown) => reply({ ok: false, error: errorMessage(error) }),
    );
    return true;
  };
}

/** The bootstrap page reports a failure it could not recover from; the failure ack answers the token. */
export function createFailureListener(
  fail: (token: string, step: BootstrapStep, error: string) => Promise<void>,
  own: { extensionId: string; extensionUrl: string },
) {
  return (message: unknown, sender: Sender, reply: (answer: BackgroundReply) => void) => {
    const ownPage = sender.id === own.extensionId && sender.url?.startsWith(own.extensionUrl);
    const parsed = v.safeParse(PocLauncherFailureSchema, message);
    if (!parsed.success || !ownPage) return false;
    const { token, step, error } = parsed.output;
    fail(token, step, error).then(
      () => reply({ ok: true }),
      (cause: unknown) => reply({ ok: false, error: errorMessage(cause) }),
    );
    return true;
  };
}
