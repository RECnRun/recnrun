import { errorMessage } from "@recnrun/domain";
import * as v from "valibot";
import { downloadsWriter } from "@/background/downloads-publisher";
import type { WriterPort } from "@/background/downloads-publisher";
import type { BackgroundReply } from "@/messaging/background-reply";
import { PocPrepareWorkersSchema } from "@/messaging/poc-prepare";
import type { PocPrepareWorkers } from "@/messaging/poc-prepare";
import { operationPath } from "@/p2p/downloads-rendezvous";
import type { IdentityStatement } from "@/p2p/identity-key";
import { PrepareRequestSchema } from "@/p2p/prepare";

/*
 * P6.1 (POC PLAN.md decision 11): the master's "Prepare workers" request and retry, written through
 * chrome.downloads under its own Downloads root for the launcher to read. Only the master asks.
 */

export interface PrepareDependencies {
  downloads: WriterPort;
  /** The master record's profile id, or undefined when this profile is not the master. */
  masterProfileId: () => Promise<string | undefined>;
  /** The statement of the presence published last, or undefined before the first one. */
  identity: () => Promise<IdentityStatement | undefined>;
  namespace: () => Promise<string>;
  written: { has: (id: string) => Promise<boolean>; add: (id: string) => Promise<void> };
  now?: () => number;
}

type Choice = Extract<PocPrepareWorkers, { op: "request" }>["choice"];

/** Writes request.json once for an operation; the key order is PrepareRequestSchema's. */
export async function writePrepareRequest(
  deps: PrepareDependencies,
  choice: Choice,
): Promise<void> {
  const masterProfileId = await deps.masterProfileId();
  if (!masterProfileId) throw new Error("Only the master prepares workers.");
  const identity = await deps.identity();
  if (!identity) throw new Error("No presence has been published yet.");
  if (await deps.written.has(choice.operationId))
    throw new Error(`Operation ${choice.operationId} was already written.`);
  const namespace = await deps.namespace();
  const request = v.parse(PrepareRequestSchema, {
    operationId: choice.operationId,
    kind: "prepare-workers",
    basesDir: choice.basesDir,
    baseName: choice.baseName,
    clones: choice.clones,
    namespace,
    masterProfileId,
    masterIdentity: identity,
    createdAt: (deps.now ?? Date.now)(),
  });
  await deps.written.add(choice.operationId);
  await downloadsWriter(deps.downloads).write(
    operationPath(namespace, choice.operationId, "request.json"),
    JSON.stringify(request),
  );
}

/** Writes the empty retry file of an operation this profile wrote, which the launcher consumes. */
export async function writePrepareRetry(
  deps: PrepareDependencies,
  operationId: string,
): Promise<void> {
  if (!(await deps.masterProfileId())) throw new Error("Only the master prepares workers.");
  if (!(await deps.written.has(operationId)))
    throw new Error(`Operation ${operationId} was not written by this profile.`);
  await downloadsWriter(deps.downloads).write(
    operationPath(await deps.namespace(), operationId, "retry"),
    "",
  );
}

interface Sender {
  id?: string;
  url?: string;
}

/** The dashboard of this extension asks; any other sender, and any other message, is left alone. */
export function createPrepareListener(
  deps: PrepareDependencies,
  own: { extensionId: string; extensionUrl: string },
) {
  return (message: unknown, sender: Sender, reply: (answer: BackgroundReply) => void) => {
    const ownPage = sender.id === own.extensionId && sender.url?.startsWith(own.extensionUrl);
    const parsed = v.safeParse(PocPrepareWorkersSchema, message);
    if (!parsed.success || !ownPage) return false;
    const request = parsed.output;
    const done =
      request.op === "request"
        ? writePrepareRequest(deps, request.choice)
        : writePrepareRetry(deps, request.operationId);
    done.then(
      () => reply({ ok: true }),
      (error: unknown) => reply({ ok: false, error: errorMessage(error) }),
    );
    return true;
  };
}
