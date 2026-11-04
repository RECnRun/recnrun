import { createPins } from "@/p2p/pins";
import { BoundWorkerSchema, RoleRecordSchema, createRoles } from "@/p2p/roles";
import { peerPinsRepository, peerRecords, repository } from "@/storage/peer-repository";

const create = () => ({
  // Local, so a worker's binding to its master survives a restart and a Forget alike.
  role: repository("local:role", RoleRecordSchema),
  /** On the master: the workers it bound, so a status or result from anyone else is refused. */
  workers: peerRecords("local:boundWorkers", BoundWorkerSchema),
});

let stores: ReturnType<typeof create> | undefined;

/** The stored hierarchy, made on first call: items made at load would stay in the production background. */
export const roleStores = () => (stores ??= create());

/** This profile's recorded role, bound master or bound workers, and the pins that prove them. */
export const storedRoles = () =>
  createRoles({ ...roleStores(), pins: createPins(peerPinsRepository) });
