import * as v from "valibot";

const TabIdSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

/** The dashboard that took control asks to record a tab, or to show the one a session records. */
const StartSessionMessageSchema = v.object({
  type: v.literal("start-session"),
  tabId: TabIdSchema,
});

/** The dashboard whose PiP window closed asks for the focus back on its own tab. */
const ReturnToDashboardMessageSchema = v.object({
  type: v.literal("return-to-dashboard"),
});

export const SessionRequestSchema = v.variant("type", [
  StartSessionMessageSchema,
  ReturnToDashboardMessageSchema,
]);

export type SessionRequest = v.InferOutput<typeof SessionRequestSchema>;

export const startSessionMessage = (tabId: number): SessionRequest => ({
  type: "start-session",
  tabId,
});

export const returnToDashboardMessage = (): SessionRequest => ({ type: "return-to-dashboard" });
