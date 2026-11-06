import * as v from "valibot";
import { downloadsWriter } from "@/background/downloads-publisher";
import type { WriterPort } from "@/background/downloads-publisher";
import { pausedPath } from "@/p2p/downloads-rendezvous";
import { IdentityStatementSchema } from "@/p2p/identity-key";
import type { IdentityStatement } from "@/p2p/identity-key";
import { ProfileIdSchema } from "@/p2p/protocol";
import { pocTransportStore } from "@/storage/poc-transport-repository";

/*
 * P4 review (POC PLAN.md decision 11): the launcher never reads silence as intent, because a
 * healthy linked profile goes silent on purpose. Disconnect and Forget say so in this file.
 */

/** Why a profile tells the launcher to leave it alone, or `resumed` once it is back. */
export type PauseReason = "disconnect" | "forget" | "resumed";

/** The keys follow this order in the file, which is what the launcher reads. */
const PauseSchema = v.strictObject({
  profileId: ProfileIdSchema,
  reason: v.picklist(["disconnect", "forget", "resumed"]),
  identity: IdentityStatementSchema,
  createdAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

export interface PauseDependencies {
  downloads: WriterPort;
  profileId: () => Promise<string>;
  /** The statement a presence would carry now. */
  identity: () => Promise<IdentityStatement>;
  namespace: () => Promise<string>;
  now?: () => number;
}

/** Writes this profile's statement under its own folder, replacing the earlier one. */
export async function writePause(deps: PauseDependencies, reason: PauseReason): Promise<void> {
  const profileId = await deps.profileId();
  const path = pausedPath(await deps.namespace(), profileId);
  const pause = v.parse(PauseSchema, {
    profileId,
    reason,
    identity: await deps.identity(),
    createdAt: (deps.now ?? Date.now)(),
  });
  await downloadsWriter(deps.downloads).write(path, JSON.stringify(pause));
  // The diagnostics page shows what was last stated; a failed note must not fail the statement.
  await pocTransportStore()
    .setPaused(reason)
    .catch(() => {});
}
