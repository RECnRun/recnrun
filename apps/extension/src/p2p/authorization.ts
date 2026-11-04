import type { MessageOf, PeerMessage, PeerType } from "@/p2p/protocol";
import type { Roles } from "@/p2p/roles";

type MessageClass = "command" | "result" | "status" | "heartbeat" | "signaling";

/** What each protocol type may do; a new type fails the type check until it is classified here. */
export const MESSAGE_CLASSES = {
  ACTIVATE_TAB: "command",
  SESSION_START: "command",
  SESSION_SET_STATUS: "command",
  SESSION_STOP: "command",
  HELLO: "status",
  GET_TABS: "status",
  TABS_CHANGED: "status",
  SESSION_STATUS: "status",
  TABS_SNAPSHOT: "result",
  COMMAND_RESULT: "result",
  ERROR: "result",
  BYE: "heartbeat",
  MEMBERS: "signaling",
  SIGNAL: "signaling",
  INVITE: "signaling",
} as const satisfies Record<PeerType, MessageClass>;

type CommandType = {
  [T in PeerType]: (typeof MESSAGE_CLASSES)[T] extends "command" ? T : never;
}[PeerType];
export type Command = MessageOf<CommandType>;

/** The types only the bound master may send; the executor runs exactly these. */
export const COMMAND_TYPES: ReadonlySet<PeerType> = new Set<CommandType>([
  "ACTIVATE_TAB",
  "SESSION_START",
  "SESSION_SET_STATUS",
  "SESSION_STOP",
]);

export const isCommand = (message: PeerMessage): message is Command =>
  COMMAND_TYPES.has(message.type);

/** The peer of the link a frame came over, with the certificate its DTLS handshake proved. */
export interface Sender {
  profileId: string;
  fingerprint: string;
}

export type Hierarchy = Pick<Roles, "roleOf" | "isMasterIdentity" | "isBoundWorker">;
export type Authorization = { ok: true } | { ok: false; reason: string };

const ALLOWED: Authorization = { ok: true };
const refused = (reason: string): Authorization => ({ ok: false, reason });

async function authorizeOrder(message: PeerMessage, sender: Sender, roles: Hierarchy) {
  // A relay proves its own certificate over its link, never its author's.
  if (message.from !== sender.profileId)
    return refused(`relayed by ${sender.profileId}, so its author's certificate is unproven`);
  if (await roles.isMasterIdentity(message.from, sender.fingerprint)) return ALLOWED;
  return refused("not the bound master");
}

async function authorizeReport(sender: Sender, roles: Hierarchy) {
  if ((await roles.roleOf()) !== "master") return ALLOWED;
  if (await roles.isBoundWorker(sender.profileId, sender.fingerprint)) return ALLOWED;
  return refused("not a bound worker");
}

/**
 * Whether this profile acts on `message`, by the sender's verified identity and the hierarchy it
 * recorded alone: never by a `role` field, the topology, a directory name, or profile id order.
 * Heartbeat and signaling relays pass between any verified peers and carry no authority.
 */
export async function authorizeCommand(
  message: PeerMessage,
  sender: Sender,
  roles: Hierarchy,
): Promise<Authorization> {
  const kind = MESSAGE_CLASSES[message.type];
  try {
    if ((await roles.roleOf()) === "template") return refused("this profile is a template");
    if (kind === "heartbeat" || kind === "signaling") return ALLOWED;
    if (kind === "command") return await authorizeOrder(message, sender, roles);
    return await authorizeReport(sender, roles);
  } catch {
    return refused("the recorded role cannot be read");
  }
}
