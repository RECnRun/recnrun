import * as v from "valibot";

const CHANNEL = "recnrun-frame";
export const PathSchema = v.pipe(v.string(), v.startsWith("/"));

/** The content script tells the dashboard which site path the address bar shows. */
export const RouteMessageSchema = v.object({
  channel: v.literal(CHANNEL),
  type: v.literal("route"),
  path: PathSchema,
});

/** The dashboard asks the content script to reflect its route and title in the site tab. */
export const LocationMessageSchema = v.object({
  channel: v.literal(CHANNEL),
  type: v.literal("location"),
  path: PathSchema,
  title: v.string(),
});

/** The framed dashboard asks the site to open the recording panel, since a frame cannot. */
export const OpenPanelMessageSchema = v.object({
  channel: v.literal(CHANNEL),
  type: v.literal("open-panel"),
});

/** The panel inside the PiP window asks the content script to close that window. */
export const ClosePanelMessageSchema = v.object({
  channel: v.literal(CHANNEL),
  type: v.literal("close-panel"),
});

type RouteMessage = v.InferOutput<typeof RouteMessageSchema>;
type LocationMessage = v.InferOutput<typeof LocationMessageSchema>;
type OpenPanelMessage = v.InferOutput<typeof OpenPanelMessageSchema>;
type ClosePanelMessage = v.InferOutput<typeof ClosePanelMessageSchema>;

export const openPanelMessage = (): OpenPanelMessage => ({ channel: CHANNEL, type: "open-panel" });

export const closePanelMessage = (): ClosePanelMessage => ({
  channel: CHANNEL,
  type: "close-panel",
});

export const routeMessage = (path: string): RouteMessage => ({
  channel: CHANNEL,
  type: "route",
  path,
});

export const locationMessage = (path: string, title: string): LocationMessage => ({
  channel: CHANNEL,
  type: "location",
  path,
  title,
});
