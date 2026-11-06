import { errorMessage } from "@recnrun/domain";
import * as v from "valibot";
import { downloadsWriter } from "@/background/downloads-publisher";
import type { PrepareDependencies } from "@/background/poc-prepare";
import type { BackgroundReply } from "@/messaging/background-reply";
import { PocCloneControlSchema } from "@/messaging/poc-clone-control";
import { CloneControlRequestSchema } from "@/p2p/clone-control";
import type { CloneControlChoice } from "@/p2p/clone-control";
import { controlPath } from "@/p2p/downloads-rendezvous";

/*
 * P7.6 (POC PLAN.md): the master's close, open, and reopen of a worker clone, written through
 * chrome.downloads under its own Downloads root for the launcher to read. Only the master asks.
 */

/** Writes request.json once for a request id; the key order is CloneControlRequestSchema's. */
export async function writeCloneControl(
  deps: PrepareDependencies,
  choice: CloneControlChoice,
): Promise<void> {
  const masterProfileId = await deps.masterProfileId();
  if (!masterProfileId) throw new Error("Only the master controls clones.");
  const identity = await deps.identity();
  if (!identity) throw new Error("No presence has been published yet.");
  if (await deps.written.has(choice.requestId))
    throw new Error(`Request ${choice.requestId} was already written.`);
  const namespace = await deps.namespace();
  const request = v.parse(CloneControlRequestSchema, {
    requestId: choice.requestId,
    kind: "clone-control",
    action: choice.action,
    instanceId: choice.instanceId,
    namespace,
    masterProfileId,
    masterIdentity: identity,
    createdAt: (deps.now ?? Date.now)(),
  });
  await deps.written.add(choice.requestId);
  await downloadsWriter(deps.downloads).write(
    controlPath(namespace, choice.requestId, "request.json"),
    JSON.stringify(request),
  );
}

interface Sender {
  id?: string;
  url?: string;
}

/** The dashboard of this extension asks; any other sender, and any other message, is left alone. */
export function createCloneControlListener(
  deps: PrepareDependencies,
  own: { extensionId: string; extensionUrl: string },
) {
  return (message: unknown, sender: Sender, reply: (answer: BackgroundReply) => void) => {
    const ownPage = sender.id === own.extensionId && sender.url?.startsWith(own.extensionUrl);
    const parsed = v.safeParse(PocCloneControlSchema, message);
    if (!parsed.success || !ownPage) return false;
    writeCloneControl(deps, parsed.output.choice).then(
      () => reply({ ok: true }),
      (error: unknown) => reply({ ok: false, error: errorMessage(error) }),
    );
    return true;
  };
}
