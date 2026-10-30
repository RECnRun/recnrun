import { IdentityListSchema } from "@recnrun/domain";
import type { Identity } from "@recnrun/domain";
import * as v from "valibot";
import { storage } from "wxt/utils/storage";
import type { IdentityRepository } from "@/ports/identities";

// Local storage: identities are kept after Incognito closes and across browser restarts.
const identitiesItem = storage.defineItem<unknown>("local:identities");

const MISMATCH = "The identities do not match the current schema.";

function valid(value: unknown): Identity[] {
  const parsed = v.safeParse(IdentityListSchema, value);
  if (!parsed.success) throw new Error(MISMATCH);
  return parsed.output;
}

async function list(): Promise<Identity[]> {
  const stored = await identitiesItem.getValue();
  return stored === null ? [] : valid(stored);
}

let queue: Promise<unknown> = Promise.resolve();

/** One change at a time, each validated before it is stored, so no change drops another. */
function update(change: (current: Identity[]) => Identity[]): Promise<Identity[]> {
  const next = queue.then(async () => {
    const changed = valid(change(await list()));
    await identitiesItem.setValue(changed);
    return changed;
  });
  queue = next.catch(() => undefined);
  return next;
}

/** The saved identities, for the background; captures stay in `identity-captures.ts`. */
export const identityRepository: IdentityRepository = { list, update };
