import type { Snapshot } from "@recnrun/domain";
import type { SessionRequest } from "@/messaging/session-protocol";
import type { WorkspaceRequest } from "@/messaging/workspace-protocol";
import type { RecordingStore } from "@/ports/recording-store";
import type { IncognitoAccess, TabSource } from "@/ports/tabs";

/** What an extension page asks the background. */
export type PageRequest = SessionRequest | WorkspaceRequest;

/** Sends a page request to the background and resolves with its reply, which the caller validates. */
export type SendRequest = (request: PageRequest) => Promise<unknown>;

/** What the extension's pages read and do, injected so component tests need no extension APIs. */
export interface ExtensionServices {
  loadSnapshot: () => Promise<Snapshot>;
  recordings: RecordingStore;
  tabs: TabSource;
  incognito: IncognitoAccess;
  /** Keeps the site tabs' ports open, so a site tab learns when RECnRun unloads. */
  holdSitePorts: () => void;
  send: SendRequest;
}
