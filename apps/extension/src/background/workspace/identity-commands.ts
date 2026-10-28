import { restorableData } from "@recnrun/domain";
import type { CaptureCapabilities, IdentityData } from "@recnrun/domain";
import { captureIdentity, chromeCaptureApi } from "@/background/workspace/capture";
import type { CaptureDeps, CaptureSummary } from "@/background/workspace/capture";
import { chromeCookieApi } from "@/background/workspace/cookie-stores";
import { WorkspaceError } from "@/background/workspace/errors";
import { managedWindowRepository } from "@/storage/managed-window-repository";
import { createIdentityCaptures } from "@/storage/identity-captures";
import type { IdentityCaptures } from "@/storage/identity-captures";
import { identityRepository } from "@/storage/identity-repository";
import type { IdentityRepository } from "@/ports/identities";

/** A capture's Chrome APIs, the captures that are also read back and deleted, and the identities. */
export interface IdentityDeps extends CaptureDeps {
  captures: CaptureDeps["captures"] & Pick<IdentityCaptures, "read" | "remove">;
  identities: IdentityRepository;
}

/** The capture APIs of Chrome and the extension's own IndexedDB; opened on first use only. */
export function chromeIdentityDeps(): IdentityDeps {
  return {
    api: chromeCaptureApi,
    cookies: chromeCookieApi,
    captures: createIdentityCaptures(globalThis.indexedDB),
    identities: identityRepository,
  };
}

/** Captures the managed tab's page as `identityId`'s saved data, widened by `capabilities`. */
export async function captureManaged(
  identityId: string,
  deps: IdentityDeps,
  capabilities: CaptureCapabilities,
): Promise<CaptureSummary> {
  const managed = await managedWindowRepository.read();
  if (managed?.status !== "active") {
    throw new WorkspaceError("NoManagedWindow", "No Incognito workspace is open to capture.");
  }
  return captureIdentity(identityId, managed, deps, capabilities);
}

/** Where a start from `identityId`'s published capture opens, and what it restores there. */
export async function savedStart(
  identityId: string,
  captures: IdentityDeps["captures"],
): Promise<{ url: string; data: IdentityData }> {
  const capture = await captures.read(identityId);
  if (!capture) {
    throw new WorkspaceError("CaptureMissing", "RECnRun has no saved data for this identity.");
  }
  return { url: capture.url, data: restorableData(capture) };
}
