import { errorMessage } from "@recnrun/domain";
import * as v from "valibot";
import { downloadsWriter } from "@/background/downloads-publisher";
import type { WriterPort } from "@/background/downloads-publisher";
import type { BackgroundReply } from "@/messaging/background-reply";
import { PocLauncherAckSchema } from "@/messaging/poc-presence";
import type { AckClone, AckTemplate } from "@/messaging/poc-presence";
import { TokenSchema, ackPath } from "@/p2p/downloads-rendezvous";
import { IdentityStatementSchema } from "@/p2p/identity-key";
import type { IdentityStatement } from "@/p2p/identity-key";
import { SettingSchema } from "@/p2p/poc-setting";
import { ProfileIdSchema } from "@/p2p/protocol";

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

/** The bootstrap page asks, once the presence is out, for the ack of the token it was opened with. */
export function createAckListener(
  ack: (token: string, template?: AckTemplate) => Promise<void>,
  own: { extensionId: string; extensionUrl: string },
) {
  return (message: unknown, sender: Sender, reply: (answer: BackgroundReply) => void) => {
    const ownPage = sender.id === own.extensionId && sender.url?.startsWith(own.extensionUrl);
    const parsed = v.safeParse(PocLauncherAckSchema, message);
    if (!parsed.success || !ownPage) return false;
    const { token, ...rest } = parsed.output;
    const sent =
      "template" in rest
        ? ack(token, { template: rest.template, setting: rest.setting })
        : ack(token);
    sent.then(
      () => reply({ ok: true }),
      (error: unknown) => reply({ ok: false, error: errorMessage(error) }),
    );
    return true;
  };
}
