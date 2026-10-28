export { errorMessage } from "./error-message.ts";
export { type Recording } from "./recording.ts";
export {
  elapsedSeconds,
  formatElapsed,
  RecordingSessionSchema,
  toggled,
  type RecordingSession,
} from "./recording-session.ts";
export { emptySnapshot, SnapshotSchema, type Snapshot } from "./snapshot.ts";
export {
  classifyIncognitoWindows,
  isAllowedTarget,
  ManagedWindowStateSchema,
  type IncognitoWindowShape,
  type ManagedWindowState,
} from "./managed-window.ts";
export { OriginDataSchema, type OriginData } from "./origin-data.ts";
export {
  IdentityDataSchema,
  SiteCookieSchema,
  type IdentityData,
  type SiteCookie,
} from "./identity-data.ts";
export { WorkspaceOperationSchema, type WorkspaceOperation } from "./workspace-operation.ts";
export {
  CaptureCapabilitiesSchema,
  IDENTITY_CAPTURE_VERSION,
  IdentityCaptureSchema,
  restorableData,
  type CaptureCapabilities,
  type IdentityCapture,
} from "./identity-capture.ts";
export { approximateBytes, IdentityListSchema, IdentitySchema, type Identity } from "./identity.ts";
export {
  planLifecycle,
  type LifecycleCommand,
  type LifecyclePlan,
  type LifecycleRefusal,
  type LifecycleRefusalName,
  type LifecycleState,
  type LifecycleStep,
} from "./workspace-lifecycle.ts";
