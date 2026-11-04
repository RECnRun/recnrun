import { createPins } from "@/p2p/pins";
import { createRoles } from "@/p2p/roles";
import { roleStores } from "@/storage/hierarchy-repository";
import { peerPinsRepository } from "@/storage/peer-repository";

/** This profile's recorded role, bound master or bound workers, and the pins that prove them. */
export const storedRoles = () =>
  createRoles({ ...roleStores(), pins: createPins(peerPinsRepository) });
