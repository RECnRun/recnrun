import * as v from "valibot";

const TabIdSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

/** A dashboard asks the background to record a tab, in a Split View pane beside it. */
const OpenSessionMessageSchema = v.object({
  type: v.literal("open-session"),
  tabId: TabIdSchema,
});

/** A dashboard opened the session's PiP window and asks the background to record a tab. */
const FloatSessionMessageSchema = v.object({
  type: v.literal("float-session"),
  tabId: TabIdSchema,
});

export const SessionRequestSchema = v.variant("type", [
  OpenSessionMessageSchema,
  FloatSessionMessageSchema,
]);

export type SessionRequest = v.InferOutput<typeof SessionRequestSchema>;

export const openSessionMessage = (tabId: number): SessionRequest => ({
  type: "open-session",
  tabId,
});

export const floatSessionMessage = (tabId: number): SessionRequest => ({
  type: "float-session",
  tabId,
});
