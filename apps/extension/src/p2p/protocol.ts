import { RecordingSessionSchema } from "@recnrun/domain";
import * as v from "valibot";

const PEER_CHANNEL = "recnrun-peer";
const PEER_PROTOCOL = 1;
/** Bigger frames are dropped unread, so a peer cannot make the other parse megabytes. */
export const MAX_MESSAGE_BYTES = 256 * 1024;

const ShortText = (max: number) => v.pipe(v.string(), v.maxLength(max));
export const ProfileIdSchema = v.pipe(v.string(), v.uuid());
const RequestIdSchema = v.pipe(v.string(), v.nonEmpty(), v.maxLength(64));
const TabIdSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

const envelope = {
  channel: v.literal(PEER_CHANNEL),
  protocol: v.literal(PEER_PROTOCOL),
  id: RequestIdSchema,
  from: ProfileIdSchema,
  to: ProfileIdSchema,
};

const message = <T extends string, P extends v.ObjectEntries>(type: T, payload: P) =>
  v.strictObject({ ...envelope, type: v.literal(type), ...payload });

/** A tab as another profile lists it: no favicon, which would load with this profile's cookies. */
export const RemoteTabSchema = v.strictObject({
  id: TabIdSchema,
  windowId: v.pipe(v.number(), v.integer()),
  incognito: v.literal(false),
  title: ShortText(2048),
  url: ShortText(8192),
});

export type RemoteTab = v.InferOutput<typeof RemoteTabSchema>;

const tabs = {
  tabs: v.pipe(v.array(RemoteTabSchema), v.maxLength(1000)),
  currentId: v.optional(TabIdSchema),
};

export const SessionStatusSchema = v.strictObject({
  session: v.nullable(RecordingSessionSchema),
  /** The profile whose dashboard controls the session; null when the executor started it. */
  controlledBy: v.nullable(ProfileIdSchema),
});

/** The closed set of things a peer may say; anything else is dropped. */
export const PeerMessageSchema = v.variant("type", [
  message("HELLO", { displayName: ShortText(64), extensionVersion: ShortText(32) }),
  message("PING", { timestamp: v.number() }),
  message("PONG", { requestId: RequestIdSchema, timestamp: v.number() }),
  message("GET_TABS", {}),
  message("TABS_SNAPSHOT", { requestId: RequestIdSchema, ...tabs }),
  message("TABS_CHANGED", tabs),
  message("ACTIVATE_TAB", { tabId: TabIdSchema }),
  message("SESSION_START", { tabId: TabIdSchema }),
  message("SESSION_SET_STATUS", { status: v.picklist(["recording", "paused"]) }),
  message("SESSION_STOP", {}),
  message("GET_SESSION", {}),
  message("SESSION_STATUS", {
    requestId: v.optional(RequestIdSchema),
    ...SessionStatusSchema.entries,
  }),
  message("COMMAND_RESULT", {
    requestId: RequestIdSchema,
    ok: v.boolean(),
    reason: v.optional(ShortText(200)),
  }),
  message("ERROR", { requestId: v.optional(RequestIdSchema), reason: ShortText(200) }),
]);

export type PeerMessage = v.InferOutput<typeof PeerMessageSchema>;
export type PeerType = PeerMessage["type"];
type MessageOf<T extends PeerType> = Extract<PeerMessage, { type: T }>;
export type PeerPayload<T extends PeerType> = Omit<MessageOf<T>, keyof typeof envelope | "type">;

/** Builds a message with a fresh id; `from` and `to` are the two profile ids. */
export function peerMessage<T extends PeerType>(
  type: T,
  route: { from: string; to: string },
  payload: PeerPayload<T>,
): MessageOf<T> {
  const id = crypto.randomUUID();
  const built = { channel: PEER_CHANNEL, protocol: PEER_PROTOCOL, id, ...route, type, ...payload };
  return built as unknown as MessageOf<T>;
}

/** Parses a raw DataChannel frame; undefined for anything oversized, malformed, or unknown. */
export function parsePeerFrame(frame: unknown): PeerMessage | undefined {
  if (typeof frame !== "string" || frame.length > MAX_MESSAGE_BYTES) return undefined;
  try {
    const parsed = v.safeParse(PeerMessageSchema, JSON.parse(frame));
    return parsed.success ? parsed.output : undefined;
  } catch {
    return undefined;
  }
}
