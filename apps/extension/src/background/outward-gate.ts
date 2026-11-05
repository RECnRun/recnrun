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
  /**
   * Wraps `start` so it runs once, and not while the role is a template: a call after the clone
   * bootstrap changed the role starts it then.
   */
  const startOutward = <T>(start: () => Promise<T>) => {
    let begun: Promise<T> | undefined;
    return async (): Promise<T | undefined> => {
      try {
        if (!begun && !(await mayAnnounce())) {
          log("role template: no announcement, discovery, or pairing");
          return undefined;
        }
        begun ??= start();
        return await begun;
      } catch (error) {
        log(errorMessage(error));
      }
      return undefined;
    };
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
  presence: (() => Promise<{ mark: Mark } | undefined>) | undefined,
  log: (entry: string) => void,
): Mark | undefined {
  if (!presence) return undefined;
  return async (reason) => {
    try {
      await (await presence())?.mark(reason);
    } catch (error) {
      log(errorMessage(error));
    }
  };
}
