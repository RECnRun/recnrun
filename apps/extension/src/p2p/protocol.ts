import { RecordingSessionSchema } from "@recnrun/domain";
import * as v from "valibot";

const PEER_CHANNEL = "recnrun-peer";
const PEER_PROTOCOL = 1;
/** Bigger frames are dropped unread, so a peer cannot make the other parse megabytes. */
export const MAX_FRAME_LENGTH = 256 * 1024;

const text = (max: number) => v.pipe(v.string(), v.maxLength(max));
export const ProfileIdSchema = v.pipe(v.string(), v.uuid());
const MessageIdSchema = v.pipe(v.string(), v.uuid());
const TabIdSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

const envelope = {
  channel: v.literal(PEER_CHANNEL),
  protocol: v.literal(PEER_PROTOCOL),
  id: MessageIdSchema,
  from: ProfileIdSchema,
  to: ProfileIdSchema,
};

const message = <T extends string, P extends v.ObjectEntries>(type: T, payload: P) =>
  v.strictObject({ ...envelope, type: v.literal(type), ...payload });

/**
 * A tab as its profile shares it: never incognito, and no favicon, which the other profile would
 * load with its own cookies. Its global identity is the sender's profile id and this `id`.
 */
const RemoteTabSchema = v.strictObject({
  id: TabIdSchema,
  windowId: v.pipe(v.number(), v.integer()),
  incognito: v.literal(false),
  title: text(2048),
  url: text(8192),
});

export const SharedTabsSchema = v.strictObject({
  tabs: v.pipe(v.array(RemoteTabSchema), v.maxLength(1000)),
  currentId: v.optional(TabIdSchema),
});

export type SharedTabs = v.InferOutput<typeof SharedTabsSchema>;

const sessionStatus = {
  session: v.nullable(RecordingSessionSchema),
  /** The profile whose dashboard started the session; null when the executor's own user did. */
  controlledBy: v.nullable(ProfileIdSchema),
};

const reply = { requestId: MessageIdSchema };

/** The closed set of things a peer may say; anything else is dropped. */
const PeerMessageSchema = v.variant("type", [
  message("HELLO", { displayName: text(64), extensionVersion: text(32) }),
  message("PING", { timestamp: v.number() }),
  message("PONG", { ...reply, timestamp: v.number() }),
  message("GET_TABS", {}),
  message("TABS_SNAPSHOT", { ...reply, ...SharedTabsSchema.entries }),
  message("TABS_CHANGED", SharedTabsSchema.entries),
  message("ACTIVATE_TAB", { tabId: TabIdSchema }),
  message("SESSION_START", { tabId: TabIdSchema }),
  message("SESSION_SET_STATUS", { status: v.picklist(["recording", "paused"]) }),
  message("SESSION_STOP", {}),
  message("SESSION_STATUS", { requestId: v.optional(MessageIdSchema), ...sessionStatus }),
  message("COMMAND_RESULT", { ...reply, ok: v.boolean(), reason: v.optional(text(200)) }),
  message("ERROR", { requestId: v.optional(MessageIdSchema), reason: text(200) }),
]);

export type PeerMessage = v.InferOutput<typeof PeerMessageSchema>;
export type PeerType = PeerMessage["type"];
export type MessageOf<T extends PeerType> = Extract<PeerMessage, { type: T }>;
export type PeerPayload<T extends PeerType> = Omit<MessageOf<T>, keyof typeof envelope | "type">;

export interface PeerRoute {
  from: string;
  to: string;
}

/** Builds a message with a fresh id. */
export function peerMessage<T extends PeerType>(
  type: T,
  route: PeerRoute,
  payload: PeerPayload<T>,
): MessageOf<T> {
  const built = {
    channel: PEER_CHANNEL,
    protocol: PEER_PROTOCOL,
    id: crypto.randomUUID(),
    ...route,
    type,
    ...payload,
  };
  // The spread of a payload of the matching type yields that type; TypeScript cannot follow it.
  return built as unknown as MessageOf<T>;
}

/** Parses a raw DataChannel frame; undefined for anything oversized, malformed, or unknown. */
export function parsePeerFrame(frame: string): PeerMessage | undefined {
  if (frame.length > MAX_FRAME_LENGTH) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(frame);
  } catch {
    return undefined;
  }
  const parsed = v.safeParse(PeerMessageSchema, json);
  return parsed.success ? parsed.output : undefined;
}
