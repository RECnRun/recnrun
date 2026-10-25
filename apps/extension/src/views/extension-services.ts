import type { Snapshot } from "@recnrun/domain";
import type { SessionRequest } from "@/messaging/session-protocol";
import type { RecordingStore } from "@/ports/recording-store";
import type { IncognitoAccess, TabSource } from "@/ports/tabs";
import type { ToolbarPin } from "@/ports/toolbar";
import type { PeerServices } from "@/views/remote-peer";

/** Sends a session request to the background and resolves with its reply, which the caller validates. */
export type SendRequest = (request: SessionRequest) => Promise<unknown>;

/** What the extension's pages read and do, injected so component tests need no extension APIs. */
export interface ExtensionServices {
  loadSnapshot: () => Promise<Snapshot>;
  recordings: RecordingStore;
  tabs: TabSource;
  incognito: IncognitoAccess;
  toolbar: ToolbarPin;
  send: SendRequest;
  /** The paired Chrome profile, in builds with the cross-profile POC. */
  peers?: PeerServices;
}
