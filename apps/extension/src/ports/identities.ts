import type { Identity } from "@recnrun/domain";

/** The saved identities, kept on this computer after Incognito closes. */
export interface IdentityRepository {
  list: () => Promise<Identity[]>;
  /** Applies one change at a time to the whole list and resolves with what it stored. */
  update: (change: (current: Identity[]) => Identity[]) => Promise<Identity[]>;
}
