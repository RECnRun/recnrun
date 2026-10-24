import type { RecordingSession } from "@recnrun/domain";
import * as v from "valibot";
import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import { SessionRequestSchema } from "@/messaging/session-protocol";

/** The session storage the background reads and writes; the extension keeps one session. */
export interface SessionStore {
  read: () => Promise<RecordingSession | null>;
  write: (session: RecordingSession | null) => Promise<void>;
}

async function focus(tabId: number): Promise<void> {
  const tab = await browser.tabs.update(tabId, { active: true });
  if (tab?.windowId !== undefined) await browser.windows.update(tab.windowId, { focused: true });
}

/** Records the tab unless a session runs, which it keeps, then shows the tab the session records. */
export async function startSession(
  tabId: number,
  store: SessionStore,
  now = Date.now(),
): Promise<void> {
  // A stored session that no longer matches the schema gives way to the new one.
  const current = await store.read().catch(() => null);
  const session = current ?? { tabId, status: "recording", banked: 0, since: now };
  if (current === null) await store.write(session);
  await focus(session.tabId);
}

const focusSender = ({ tab }: Browser.runtime.MessageSender) =>
  tab?.id === undefined ? Promise.resolve() : focus(tab.id);

/**
 * Answers session requests from the extension's own pages, never from its content scripts. The
 * dashboard sending them is framed in a site tab, which is the tab it gets the focus back to.
 */
export function createSessionListener(store: SessionStore, extensionUrl: string) {
  return (message: unknown, sender: Browser.runtime.MessageSender) => {
    const request = v.safeParse(SessionRequestSchema, message);
    // A content script shares the extension id but runs in a web page that may be compromised.
    if (sender.id !== browser.runtime.id || !sender.url?.startsWith(extensionUrl)) return false;
    if (!request.success) return false;
    const done =
      request.output.type === "start-session"
        ? startSession(request.output.tabId, store)
        : focusSender(sender);
    // The tab may have closed meanwhile; the next dashboard view shows where things stand.
    void done.catch(() => {});
    return false;
  };
}
