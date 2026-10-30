import type { Page, Worker } from "@playwright/test";

/** Fixed by `manifest.key`, so the skill and the tests can hardcode it. */
export const EXTENSION_ID = "diabhlabffpmdllbkikfpnekcfndipao";

export const APP_ORIGIN = "http://localhost:4300";

export const APP_HTML = `<!doctype html><html lang="en"><head><title>Fixture app</title></head><body>
<form onsubmit="event.preventDefault()">
  <label>Email <input id="email" name="email" /></label>
  <label>Password <input id="password" name="password" type="password" /></label>
  <button type="button" data-testid="save">Save</button>
</form></body></html>`;

interface ChromeGlobal {
  chrome?: {
    runtime?: { sendMessage?: (id: string, message: unknown) => Promise<unknown> };
    tabs: { query(info: object): Promise<Array<{ url?: string; groupId: number }>> };
    tabGroups: { get(id: number): Promise<{ title?: string }> };
  };
}

export type ApiReply =
  | { ok: true; result: { status?: string; workflow?: { id: string; status: string } } }
  | { ok: false; error: string };

/** What an agent does: `chrome.runtime.sendMessage(RECNRUN_EXTENSION_ID, …)` from page JavaScript. */
export function callApi(page: Page, type: string, payload?: unknown): Promise<ApiReply> {
  return page.evaluate(
    ([id, message]) => {
      const send = (globalThis as ChromeGlobal).chrome?.runtime?.sendMessage;
      if (!send) throw new Error("chrome.runtime.sendMessage is not available on this page.");
      return send(id, message) as Promise<ApiReply>;
    },
    [EXTENSION_ID, { kind: "request", type, payload }] as const,
  );
}

export function hasApi(page: Page): Promise<boolean> {
  return page.evaluate(
    () => typeof (globalThis as ChromeGlobal).chrome?.runtime?.sendMessage === "function",
  );
}

/** The group id of every tab whose URL starts with the prefix, and the group's title. */
export async function groupOf(serviceWorker: Worker, urlPrefix: string) {
  return serviceWorker.evaluate(async (prefix) => {
    const { chrome } = globalThis as unknown as Required<ChromeGlobal>;
    const tabs = (await chrome.tabs.query({})).filter((tab) => tab.url?.startsWith(prefix));
    const ids = [...new Set(tabs.map((tab) => tab.groupId))];
    const [groupId] = ids;
    const title =
      groupId !== undefined && groupId !== -1
        ? (await chrome.tabGroups.get(groupId)).title
        : undefined;
    return { ids, title };
  }, urlPrefix);
}
