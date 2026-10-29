import {
  IdentitySchema,
  ManagedWindowStateSchema,
  WorkspaceOperationSchema,
} from "@recnrun/domain";
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

const IdentityIdSchema = v.pipe(v.string(), v.minLength(1));

/** The dashboard asks to save the open identity, close it, and open another. */
const WorkspaceSwitchMessageSchema = v.object({
  type: v.literal("workspace-switch"),
  identityId: IdentityIdSchema,
});

/** The dashboard asks to save the open identity and close its window. */
const WorkspaceSuspendMessageSchema = v.object({ type: v.literal("workspace-suspend") });

/** The dashboard asks to open a saved identity, with no workspace open. */
const WorkspaceResumeMessageSchema = v.object({
  type: v.literal("workspace-resume"),
  identityId: IdentityIdSchema,
});

/**
 * The dashboard asks to save the open identity, if any, and open a new one empty; `closeWindowIds`
 * are the other Incognito windows it showed the user, closed without being saved.
 */
const WorkspaceNewIdentityMessageSchema = v.object({
  type: v.literal("workspace-new-identity"),
  label: v.string(),
  url: v.string(),
  closeWindowIds: v.optional(v.array(BrowserIdSchema)),
});

/** The dashboard asks to delete a saved identity that is not open, and its captures. */
const WorkspaceDeleteIdentityMessageSchema = v.object({
  type: v.literal("workspace-delete-identity"),
  identityId: IdentityIdSchema,
});

export const WorkspaceRequestSchema = v.variant("type", [
  WorkspaceStatusMessageSchema,
  WorkspaceStartMessageSchema,
  WorkspaceCloseAndStartMessageSchema,
  WorkspaceRestartMessageSchema,
  WorkspaceSwitchMessageSchema,
  WorkspaceSuspendMessageSchema,
  WorkspaceResumeMessageSchema,
  WorkspaceNewIdentityMessageSchema,
  WorkspaceDeleteIdentityMessageSchema,
]);

export type WorkspaceRequest = v.InferOutput<typeof WorkspaceRequestSchema>;

/** The `workspace-status` result; foreign windows carry no title or URL. */
export const WorkspaceStatusSchema = v.object({
  /** Whether this build has the workspace's APIs; a production build has none of them (OD-1). */
  available: v.boolean(),
  access: v.boolean(),
  managed: v.optional(ManagedWindowStateSchema),
  foreign: v.array(v.object({ id: BrowserIdSchema, tabCount: BrowserIdSchema })),
  busy: v.boolean(),
  /** The saved identities, kept on this computer after Incognito closes. */
  identities: v.array(IdentitySchema),
  /** The last start with an identity or lifecycle command, while it runs and after it ends. */
  operation: v.optional(WorkspaceOperationSchema),
});

export type WorkspaceStatus = v.InferOutput<typeof WorkspaceStatusSchema>;
