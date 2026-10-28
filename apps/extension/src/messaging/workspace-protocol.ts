import { ManagedWindowStateSchema } from "@recnrun/domain";
import * as v from "valibot";

const BrowserIdSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

/** The dashboard asks what blocks or holds the Incognito workspace. */
const WorkspaceStatusMessageSchema = v.object({ type: v.literal("workspace-status") });

/** The dashboard asks to open the managed window on a target, with no Incognito window open. */
const WorkspaceStartMessageSchema = v.object({
  type: v.literal("workspace-start"),
  url: v.string(),
});

/** The dashboard asks to close the Incognito windows it showed the user, then to start. */
const WorkspaceCloseAndStartMessageSchema = v.object({
  type: v.literal("workspace-close-and-start"),
  url: v.string(),
  windowIds: v.array(BrowserIdSchema),
});

/** The dashboard asks to replace the open managed window with a fresh one on a target. */
const WorkspaceRestartMessageSchema = v.object({
  type: v.literal("workspace-restart"),
  url: v.string(),
});

export const WorkspaceRequestSchema = v.variant("type", [
  WorkspaceStatusMessageSchema,
  WorkspaceStartMessageSchema,
  WorkspaceCloseAndStartMessageSchema,
  WorkspaceRestartMessageSchema,
]);

/** The `workspace-status` result; foreign windows carry no title or URL. */
export const WorkspaceStatusSchema = v.object({
  access: v.boolean(),
  managed: v.optional(ManagedWindowStateSchema),
  foreign: v.array(v.object({ id: BrowserIdSchema, tabCount: BrowserIdSchema })),
  busy: v.boolean(),
});

export type WorkspaceStatus = v.InferOutput<typeof WorkspaceStatusSchema>;
