import { createPins } from "@/p2p/pins";
import { createRoles } from "@/p2p/roles";
import {
  boundWorkersRepository,
  peerPinsRepository,
  roleRepository,
} from "@/storage/peer-repository";

/** This profile's recorded role, bound master or bound workers, and the pins that prove them. */
export const storedRoles = () =>
  createRoles({
    role: roleRepository,
    workers: boundWorkersRepository,
    pins: createPins(peerPinsRepository),
  });
