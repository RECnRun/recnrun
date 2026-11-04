import { errorMessage } from "@recnrun/domain";
import * as v from "valibot";
import { offscreenLiveness } from "@/background/link";
import { PRESENCE_TTL_MS } from "@/p2p/folder-rendezvous";
import { authorizedPeersRepository, peerLinksRepository } from "@/storage/peer-repository";

/*
 * P3.6 (POC PLAN.md, E7): POC-only policies for the alarm's presence renewal. Absent or
 * `baseline` renews every half TTL; `linked-silence` skips while every authorized peer has a
 * verified connected link; `heartbeat` skips while every authorized peer's DataChannel was heard
 * within a TTL; `launcher` leaves renewal to the launcher once the root is known.
 */
const PolicySchema = v.nullish(v.picklist(["baseline", "linked-silence", "heartbeat", "launcher"]));

async function someUnlinked(known: string[]) {
  const links = await peerLinksRepository.all();
  return known.some((id) => links[id]?.verified !== true || links[id].state !== "connected");
}

async function someSilent(known: string[]) {
  const [heard, now] = [await offscreenLiveness(), Date.now()];
  return known.some((id) => {
    const heardAt = heard[id]?.heardAt;
    return heardAt === undefined || now - heardAt >= PRESENCE_TTL_MS;
  });
}

interface RenewalOptions {
  root: () => Promise<string | null>;
  log: (entry: string) => void;
  policy: () => Promise<unknown>;
}

/** Whether the alarm writes the presence now; an explicit bootstrap publication always writes. */
export function presenceRenewal({ root, log, policy }: RenewalOptions) {
  return async () => {
    try {
      const mode = v.parse(PolicySchema, await policy());
      // A root not yet learned needs a write, which also gives the launcher this boot's presence.
      if (!mode || mode === "baseline" || (await root()) === null) return true;
      if (mode === "launcher") return false;
      const known = Object.keys(await authorizedPeersRepository.all());
      if (known.length === 0) return true;
      return mode === "heartbeat" ? await someSilent(known) : await someUnlinked(known);
    } catch (error) {
      log(`presence policy: ${errorMessage(error)}`);
      return true;
    }
  };
}
