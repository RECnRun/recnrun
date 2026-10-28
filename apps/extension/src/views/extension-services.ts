import type { Snapshot } from "@recnrun/domain";
import type { SessionRequest } from "@/messaging/session-protocol";
import type { RecordingStore } from "@/ports/recording-store";
import type { IncognitoAccess, TabSource } from "@/ports/tabs";
import type { ToolbarPin } from "@/ports/toolbar";

/** Sends a session request to the background and resolves with its reply, which the caller validates. */
export type SendRequest = (request: SessionRequest) => Promise<unknown>;

/** What the extension's pages read and do, injected so component tests need no extension APIs. */
export interface ExtensionServices {
  loadSnapshot: () => Promise<Snapshot>;
  recordings: RecordingStore;
  tabs: TabSource;
  incognito: IncognitoAccess;
  toolbar: ToolbarPin;
  /** Keeps the site tabs' ports open, so a site tab learns when RECnRun unloads. */
  holdSitePorts: () => void;
  send: SendRequest;
}
