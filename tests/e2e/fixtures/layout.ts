import type { Page, Worker } from "@playwright/test";

interface LayoutGlobal {
  chrome: {
    windows: {
      getAll(filter: object): Promise<
        {
          id?: number;
          incognito: boolean;
          focused: boolean;
          tabs?: { index: number; url?: string; pendingUrl?: string; active: boolean }[];
        }[]
      >;
    };
  };
}

/** One Incognito window as Chrome lists it: whether it has the focus, and its tabs in order. */
export interface LaidOutWindow {
  id: number;
  focused: boolean;
  tabs: { url: string; active: boolean }[];
}

/** Every Incognito window in Chrome's order, each with its tabs by index. */
export const incognitoLayout = (serviceWorker: Worker): Promise<LaidOutWindow[]> =>
  serviceWorker.evaluate(async () => {
    const { chrome } = globalThis as unknown as LayoutGlobal;
    const windows = await chrome.windows.getAll({ populate: true });
    return windows
      .filter(({ incognito }) => incognito)
      .map(({ id = -1, focused, tabs = [] }) => ({
        id,
        focused,
        tabs: [...tabs]
          .sort((one, other) => one.index - other.index)
          .map(({ url, pendingUrl, active }) => ({ url: pendingUrl ?? url ?? "", active })),
      }));
  });

/** The layout without window ids, as two captures of the same session compare. */
export const shapeOf = (layout: readonly LaidOutWindow[]) =>
  layout.map(({ focused, tabs }) => ({ focused, tabs }));

/** Writes `value` into the page's own sessionStorage, which belongs to its tab alone. */
export const writeTabSession = (page: Page, value: string) =>
  page.evaluate((written) => sessionStorage.setItem("tab", written), value);

/** What the page's tab holds in its sessionStorage, or null. */
export const tabSession = (page: Page) => page.evaluate(() => sessionStorage.getItem("tab"));
