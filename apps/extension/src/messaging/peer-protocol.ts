import * as v from "valibot";
import { RemoteTabSchema } from "@/p2p/protocol";

const TabIdSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const CodeSchema = v.pipe(v.string(), v.nonEmpty(), v.maxLength(128 * 1024));
const SdpSchema = v.pipe(v.string(), v.nonEmpty(), v.maxLength(64 * 1024));

const toBackground = <T extends string, P extends v.ObjectEntries>(type: T, payload: P) =>
  v.strictObject({ target: v.literal("background"), type: v.literal(type), ...payload });

/** What the pairing page and the dashboards ask the background about the peer. */
export const PeerRequestSchema = v.variant("type", [
  toBackground("peer-status", {}),
  toBackground("peer-rename", {
    displayName: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(64)),
  }),
  toBackground("peer-create-offer", {}),
  toBackground("peer-inspect", { code: CodeSchema }),
  toBackground("peer-accept", { code: CodeSchema }),
  toBackground("peer-disconnect", {}),
  toBackground("peer-forget", {}),
  toBackground("peer-ping", {}),
  toBackground("peer-diagnostics", {}),
  toBackground("peer-tabs", {}),
  toBackground("peer-activate", { tabId: TabIdSchema }),
  toBackground("remote-session-start", { tabId: TabIdSchema }),
  toBackground("remote-session-set", { status: v.picklist(["recording", "paused"]) }),
  toBackground("remote-session-stop", {}),
  toBackground("remote-session-forget", {}),
]);

export type PeerRequest = v.InferOutput<typeof PeerRequestSchema>;
type Distribute<T> = T extends unknown ? Omit<T, "target"> : never;

export const peerRequest = (request: Distribute<PeerRequest>) =>
  ({ target: "background", ...request }) as PeerRequest;

/** The offscreen document reports what its link received and how it is. */
export const LinkEventSchema = v.variant("type", [
  toBackground("link-frame", { frame: v.string() }),
  toBackground("link-state", {
    state: v.picklist(["idle", "connecting", "connected", "disconnected", "failed"]),
    remoteFingerprint: v.optional(v.string()),
  }),
]);

const toOffscreen = <T extends string, P extends v.ObjectEntries>(type: T, payload: P) =>
  v.strictObject({ target: v.literal("offscreen"), type: v.literal(type), ...payload });

/** What the background asks of the offscreen document, which alone holds the connection. */
export const LinkCommandSchema = v.variant("type", [
  toOffscreen("link-fingerprint", {}),
  toOffscreen("link-offer", {}),
  toOffscreen("link-answer", { sdp: SdpSchema }),
  toOffscreen("link-accept-answer", { sdp: SdpSchema }),
  toOffscreen("link-send", { frame: v.string() }),
  toOffscreen("link-close", {}),
  toOffscreen("link-info", {}),
]);

export type LinkCommand = v.InferOutput<typeof LinkCommandSchema>;

/** The background tells every page that the peer's tabs changed; nothing about tabs is stored. */
export const PeerTabsChangedSchema = v.strictObject({
  target: v.literal("pages"),
  type: v.literal("peer-tabs-changed"),
  tabs: v.array(RemoteTabSchema),
  currentId: v.optional(TabIdSchema),
});

export const ReplySchema = v.variant("ok", [
  v.object({ ok: v.literal(true), result: v.unknown() }),
  v.object({ ok: v.literal(false), error: v.string() }),
]);

export type Reply = v.InferOutput<typeof ReplySchema>;

/** Sends a runtime message and unwraps its `{ ok, result | error }` reply. */
export async function ask(
  send: (message: unknown) => Promise<unknown>,
  message: unknown,
): Promise<unknown> {
  const reply = v.safeParse(ReplySchema, await send(message));
  if (!reply.success) throw new Error("RECnRun did not answer.");
  if (!reply.output.ok) throw new Error(reply.output.error);
  return reply.output.result;
}
