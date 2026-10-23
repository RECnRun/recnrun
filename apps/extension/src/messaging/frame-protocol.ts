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

type RouteMessage = v.InferOutput<typeof RouteMessageSchema>;
type LocationMessage = v.InferOutput<typeof LocationMessageSchema>;

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
