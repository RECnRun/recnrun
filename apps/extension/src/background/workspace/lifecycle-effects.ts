import { classifyIncognitoWindows } from "@recnrun/domain";
import type {
  Identity,
  IdentityCapture,
  IdentityData,
  SkippedOrigin,
  WorkspaceOperation,
} from "@recnrun/domain";
import { bootstrapIdentity } from "@/background/workspace/bootstrap";
import type { BootstrapPorts } from "@/background/workspace/bootstrap";
import { captureIdentity, captureOrigins } from "@/background/workspace/capture";
import { closeRemembering } from "@/background/workspace/fresh-window";
import { savedStart } from "@/background/workspace/identity-commands";
import type { IdentityDeps } from "@/background/workspace/identity-commands";
import type { LifecycleEffects, Opening } from "@/background/workspace/lifecycle-types";
import { createNeutralWindow, inventory } from "@/background/workspace/windows";
import type { OperationJournal } from "@/ports/operation-journal";
import { managedWindowRepository } from "@/storage/managed-window-repository";

/** A new identity opens with nothing restored, behind the same barrier as any start. */
const NOTHING: IdentityData = {
  cookies: [],
  site: { localStorage: {}, sessionStorage: {}, indexedDB: [], caches: [] },
  origins: [],
};

async function load(identity: Identity, from: Opening["from"], deps: IdentityDeps) {
  if (from === "capture") return { from, ...(await savedStart(identity.id, deps)) };
  return { from, url: identity.url, data: NOTHING };
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
      const otherTabs = (managed?.tabs ?? []).filter(({ id }) => id !== stored?.tabId).length;
      return { ...open, foreign: foreign.map(({ id }) => id), otherTabs };
    },
    capture: async (identity, managed, operationId) => {
      await deps.captures.settle(identity.id, identity.lastCapture?.id);
      // Tentative until the identity names it: the lifecycle settles it after its persist step.
      const publish = (header: IdentityCapture) =>
        deps.captures.publish(header, { tentative: true });
      const captures = { ...deps.captures, publish };
      const capturing = { ...deps, captures, origins: captureOrigins(ports) };
      return captureIdentity(identity.id, managed, capturing, operationId);
    },
    close,
    load: (identity, from) => load(identity, from, deps),
    start: async (identity, { url, data }, operation) => {
      const windows = { create: () => createNeutralWindow(identity.id), close };
      // The bootstrap's journal entries carry the command that started it.
      let skipped: SkippedOrigin[] = [];
      const record = (written: WorkspaceOperation) => {
        skipped = written.skipped ?? skipped;
        return journal.write({ ...written, kind: operation.kind });
      };
      const timings = await bootstrapIdentity(
        url,
        data,
        { ...ports, windows, record },
        operation.id,
      );
      return { timings, skipped };
    },
    removeCaptures: (identityId) => deps.captures.remove(identityId),
    settle: (identityId, committedId) => deps.captures.settle(identityId, committedId),
    // Read at each step: the test build sets the hook after the commands exist.
    beforeStep: (step) => ports.hooks.beforeStep(step),
  };
}
