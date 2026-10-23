import * as v from "valibot";

const isWebOrigin = (value: string) => {
  if (!URL.canParse(value)) return false;
  const { protocol, origin } = new URL(value);
  return (protocol === "http:" || protocol === "https:") && origin === value;
};

/** A workspace is the web origin its recordings started on. */
export const WorkspaceSchema = v.pipe(v.string(), v.check(isWebOrigin));

/** The dashboard address's query for a workspace, or none to show every workspace. */
export const workspaceSearch = (workspace?: string) =>
  workspace === undefined ? "" : `?${new URLSearchParams({ workspace })}`;

/** The background moved the dashboard tab beside another page, whose workspace it now shows. */
export const ShowWorkspaceMessageSchema = v.object({
  type: v.literal("show-workspace"),
  tabId: v.number(),
  workspace: v.optional(WorkspaceSchema),
});

type ShowWorkspaceMessage = v.InferOutput<typeof ShowWorkspaceMessageSchema>;

export const showWorkspaceMessage = (tabId: number, workspace?: string): ShowWorkspaceMessage =>
  workspace === undefined
    ? { type: "show-workspace", tabId }
    : { type: "show-workspace", tabId, workspace };

/** Where a dashboard tab that opens while another is open hands over its route before it closes. */
export const HAND_OVER_CHANNEL = "recnrun-dashboard-tab";

/** The later tab's hash route, which the open dashboard tab shows instead; empty keeps its own. */
export const HandOverMessageSchema = v.object({
  type: v.literal("hand-over"),
  hash: v.union([v.literal(""), v.pipe(v.string(), v.startsWith("#/"))]),
});

export const handOverMessage = (hash: string) => ({ type: "hand-over", hash }) as const;
