import { errorMessage } from "@recnrun/domain";
import type { PauseReason } from "@/background/launcher-pause";
import { storedRoles } from "@/storage/hierarchy-repository";

/** The stored role's gate on everything outward; an unreadable role permits nothing. */
export function outwardGate(log: (entry: string) => void) {
  const roles = storedRoles();
  const mayAnnounce = async () =>
    (await roles.mayAct("announce")) && (await roles.mayAct("discover"));
  const outward: Outward = async (work) => {
    if (await mayAnnounce()) await work();
  };
  /** Runs `start` unless the role is a template, which waits for a later role change. */
  const startOutward = async <T>(start: () => Promise<T>): Promise<T | undefined> => {
    try {
      if (await mayAnnounce()) return await start();
      log("role template: no announcement, discovery, or pairing");
    } catch (error) {
      log(errorMessage(error));
    }
    return undefined;
  };
  return { outward, startOutward };
}

/** What a profile does outward only if its stored role lets it: a template does none of it. */
export type Outward = (work: () => Promise<void>) => Promise<void>;

type Mark = (reason: PauseReason) => Promise<void>;

/**
 * States the launcher's pause policy through the Downloads presence, if this build and role have
 * one. A failed write must not undo the user's Disconnect; the launcher then reads no pause.
 */
export function launcherMark(
  presence: Promise<{ mark: Mark } | undefined> | undefined,
  log: (entry: string) => void,
): Mark | undefined {
  if (!presence) return undefined;
  return async (reason) => {
    try {
      await (await presence)?.mark(reason);
    } catch (error) {
      log(errorMessage(error));
    }
  };
}
