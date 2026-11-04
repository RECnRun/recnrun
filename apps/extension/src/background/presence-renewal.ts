import { errorMessage } from "@recnrun/domain";
import * as v from "valibot";
import { authorizedPeersRepository, peerLinksRepository } from "@/storage/peer-repository";

/** P3.6: the POC alarm can leave liveness to verified DataChannels while every known peer is linked. */
export function presenceRenewal(
  root: () => Promise<string | null>,
  log: (entry: string) => void,
  policy: () => Promise<unknown>,
) {
  return async () => {
    try {
      const mode = v.parse(v.nullish(v.picklist(["baseline", "linked-silence"])), await policy());
      if (mode !== "linked-silence" || (await root()) === null) return true;
      const [peers, links] = await Promise.all([
        authorizedPeersRepository.all(),
        peerLinksRepository.all(),
      ]);
      const known = Object.keys(peers);
      return (
        known.length === 0 ||
        known.some((id) => links[id]?.verified !== true || links[id].state !== "connected")
      );
    } catch (error) {
      log(`presence policy: ${errorMessage(error)}`);
      return true;
    }
  };
}
