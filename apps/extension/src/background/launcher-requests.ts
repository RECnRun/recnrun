import { errorMessage } from "@recnrun/domain";
import * as v from "valibot";
import { downloadsWriter } from "@/background/downloads-publisher";
import type { DownloadsPort } from "@/background/downloads-publisher";
import type { BackgroundReply } from "@/messaging/background-reply";
import { PocLauncherAckSchema } from "@/messaging/poc-presence";
import { TokenSchema, ackPath } from "@/p2p/downloads-rendezvous";
import { IdentityStatementSchema } from "@/p2p/identity-key";
import type { IdentityStatement } from "@/p2p/identity-key";
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
  identity: IdentityStatementSchema,
  boot: v.pipe(v.string(), v.uuid()),
  createdAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

export interface AckDependencies {
  downloads: Pick<DownloadsPort, "download">;
  profileId: () => Promise<string>;
  /** The statement of the presence published last, or undefined before the first one. */
  identity: () => IdentityStatement | undefined;
  namespace: () => Promise<string>;
  /** The session's current boot, which equals the token only on a fresh start. */
  boot: () => Promise<string>;
  now?: () => number;
}

/** Writes the ack of one attempt under this profile's own folder, replacing an earlier one. */
export async function writeAck(deps: AckDependencies, token: string): Promise<void> {
  const identity = deps.identity();
  if (!identity) throw new Error("No presence has been published yet.");
  const profileId = await deps.profileId();
  const path = ackPath(await deps.namespace(), profileId, token);
  const ack = v.parse(AckSchema, {
    token,
    profileId,
    identity,
    boot: await deps.boot(),
    createdAt: (deps.now ?? Date.now)(),
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
  ack: (token: string) => Promise<void>,
  own: { extensionId: string; extensionUrl: string },
) {
  return (message: unknown, sender: Sender, reply: (answer: BackgroundReply) => void) => {
    const ownPage = sender.id === own.extensionId && sender.url?.startsWith(own.extensionUrl);
    const parsed = v.safeParse(PocLauncherAckSchema, message);
    if (!parsed.success || !ownPage) return false;
    ack(parsed.output.token).then(
      () => reply({ ok: true }),
      (error: unknown) => reply({ ok: false, error: errorMessage(error) }),
    );
    return true;
  };
}
