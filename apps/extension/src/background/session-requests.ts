import type { RecordingSession } from "@recnrun/domain";
import * as v from "valibot";
import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import { SessionRequestSchema } from "@/messaging/session-protocol";
import type { SessionReply } from "@/messaging/session-protocol";

/** The session storage the background reads and writes; the extension keeps one session. */
export interface SessionStore {
  read: () => Promise<RecordingSession | null>;
  write: (session: RecordingSession | null) => Promise<void>;
}

async function focus(tabId: number): Promise<void> {
  const tab = await browser.tabs.update(tabId, { active: true });
  if (tab?.windowId !== undefined) await browser.windows.update(tab.windowId, { focused: true });
}

/** Chrome rejects an unknown id; the fake browser resolves nothing for it. */
async function ensureOpen(tabId: number): Promise<void> {
  const tab = await browser.tabs.get(tabId).catch(() => undefined);
  if (!tab) throw new Error("The tab to record was closed.");
}

/** Records the tab unless a session runs, which it keeps, then shows the tab the session records. */
export async function startSession(
  tabId: number,
  store: SessionStore,
  now = Date.now(),
): Promise<void> {
  // An unreadable stored session is the caller's error to show, never one to overwrite.
  const current = await store.read();
  if (current === null) {
    // A session on a closed tab could only be stopped, so none starts on one.
    await ensureOpen(tabId);
    await store.write({ tabId, status: "recording", banked: 0, since: now });
  }
  await focus(current?.tabId ?? tabId);
}

const focusSender = ({ tab }: Browser.runtime.MessageSender) =>
  tab?.id === undefined ? Promise.resolve() : focus(tab.id);

/**
 * Answers session requests from the extension's own pages, never from its content scripts. The
 * dashboard sending them is framed in a site tab, which is the tab it gets the focus back to.
 */
export function createSessionListener(store: SessionStore, extensionUrl: string) {
  return (
    message: unknown,
    sender: Browser.runtime.MessageSender,
    sendResponse: (reply: SessionReply) => void,
  ) => {
    const request = v.safeParse(SessionRequestSchema, message);
    // A content script shares the extension id but runs in a web page that may be compromised.
    if (sender.id !== browser.runtime.id || !sender.url?.startsWith(extensionUrl)) return false;
    if (!request.success) return false;
    const done =
      request.output.type === "start-session"
        ? startSession(request.output.tabId, store)
        : focusSender(sender);
    done.then(
      () => sendResponse({ ok: true }),
      (error: unknown) =>
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  };
}
