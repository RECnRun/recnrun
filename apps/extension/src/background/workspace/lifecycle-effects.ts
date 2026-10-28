import { classifyIncognitoWindows } from "@recnrun/domain";
import type { Identity, IdentityData } from "@recnrun/domain";
import { bootstrapIdentity } from "@/background/workspace/bootstrap";
import type { BootstrapPorts } from "@/background/workspace/bootstrap";
import { captureIdentity } from "@/background/workspace/capture";
import { closeRemembering } from "@/background/workspace/fresh-window";
import { savedStart } from "@/background/workspace/identity-commands";
import type { IdentityDeps } from "@/background/workspace/identity-commands";
import type { LifecycleEffects } from "@/background/workspace/lifecycle";
import { createNeutralWindow, inventory } from "@/background/workspace/windows";
import type { OperationJournal } from "@/ports/operation-journal";
import { managedWindowRepository } from "@/storage/managed-window-repository";

/** A new identity opens with nothing restored, behind the same barrier as any start. */
const NOTHING: IdentityData = {
  cookies: [],
  site: { localStorage: {}, sessionStorage: {}, indexedDB: [], caches: [] },
};

async function startData(identity: Identity, from: "capture" | "empty", deps: IdentityDeps) {
  if (from === "capture") return savedStart(identity.id, deps.captures);
  return { url: identity.url, data: NOTHING };
}

/** The lifecycle's steps on Chrome: the window inventory, capture, close, bootstrap, and delete. */
export function chromeLifecycleEffects(
  ports: BootstrapPorts,
  deps: IdentityDeps,
  journal: OperationJournal,
): LifecycleEffects {
  const close = (ids: readonly number[]) => closeRemembering(ids, ports);
  return {
    windows: async () => {
      const stored = (await managedWindowRepository.read()) ?? undefined;
      const { managed, foreign } = classifyIncognitoWindows(await inventory(), stored);
      // The stored state counts only while its window is still open.
      const open = managed === undefined || stored === undefined ? {} : { managed: stored };
      return { ...open, foreign: foreign.map(({ id }) => id) };
    },
    capture: (identity, managed) =>
      captureIdentity(identity.id, managed, deps, identity.capabilities),
    close,
    start: async (identity, from, operation) => {
      const { url, data } = await startData(identity, from, deps);
      const windows = { create: () => createNeutralWindow(identity.id), close };
      // The bootstrap's journal entries carry the command that started it.
      const record = (written: Parameters<OperationJournal["write"]>[0]) =>
        journal.write({ ...written, kind: operation.kind });
      return bootstrapIdentity(url, data, { ...ports, windows, record }, operation.id);
    },
    removeCaptures: (identityId) => deps.captures.remove(identityId),
  };
}
