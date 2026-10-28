export interface DashboardTab {
  id: number;
  windowId: number;
  index: number;
  /** The address it shows, or the one it is loading. */
  url: string;
  incognito: boolean;
}

export interface BrowserWindow {
  id: number;
  incognito: boolean;
}

/** What the opener needs of Chrome's tabs and windows. */
export interface DashboardBrowser {
  tabs(): Promise<DashboardTab[]>;
  /** The normal windows. */
  windows(): Promise<BrowserWindow[]>;
  lastFocused(): Promise<BrowserWindow | undefined>;
  /** Opens the dashboard in the window, at the index or last, as its active tab. */
  open(windowId: number, index?: number): Promise<DashboardTab>;
  /** Opens the dashboard in a new focused window. */
  openWindow(): Promise<void>;
  move(tab: DashboardTab, index: number): Promise<void>;
  /** Activates the tab and focuses its window. */
  focus(tab: DashboardTab): Promise<void>;
}

export interface OpenedWindow {
  id: number;
  type?: string;
  incognito: boolean;
}

const byPosition = (a: DashboardTab, b: DashboardTab) =>
  a.windowId - b.windowId || a.index - b.index;

/** Opens the dashboard or brings it forward, so the profile keeps one in front of the user. */
export function createDashboardOpener(browser: DashboardBrowser, url: string) {
  const isDashboard = (tab: DashboardTab) => !tab.incognito && tab.url.split(/[#?]/u)[0] === url;
  const first = async () => (await browser.tabs()).filter(isDashboard).toSorted(byPosition)[0];

  /** The normal window the dashboard should open in, preferring `preferred`. */
  async function target(preferred?: BrowserWindow): Promise<number | undefined> {
    if (preferred && !preferred.incognito) return preferred.id;
    const focused = await browser.lastFocused();
    if (focused && !focused.incognito) return focused.id;
    const windows = (await browser.windows()).filter((each) => !each.incognito);
    return windows.toSorted((a, b) => a.id - b.id)[0]?.id;
  }

  async function show(clicked?: BrowserWindow) {
    const open = await first();
    if (open) return browser.focus(open);
    const windowId = await target(clicked);
    if (windowId === undefined) return browser.openWindow();
    return browser.focus(await browser.open(windowId));
  }

  async function lead(windowId?: number) {
    const open = await first();
    if (open && open.index !== 0) await browser.move(open, 0);
    if (open) return browser.focus(open);
    const into = windowId ?? (await target());
    if (into !== undefined) await browser.focus(await browser.open(into, 0));
  }

  async function windowOpened(opened: OpenedWindow) {
    if (opened.type !== "normal" || opened.incognito) return;
    const others = (await browser.windows()).filter(
      (each) => !each.incognito && each.id !== opened.id,
    );
    if (others.length === 0) await lead(opened.id);
  }

  // One step at a time, so a second click finds the tab the first one opened.
  let queue: Promise<unknown> = Promise.resolve();
  const serial =
    <A extends unknown[]>(step: (...args: A) => Promise<unknown>) =>
    (...args: A) => {
      const done = queue.then(() => step(...args));
      queue = done.catch(() => undefined);
      return done.then(() => undefined);
    };

  return {
    /** The toolbar icon: focuses the first dashboard, or opens one. */
    show: serial((clicked?: { windowId: number; incognito: boolean }) =>
      show(clicked && { id: clicked.windowId, incognito: clicked.incognito }),
    ),
    /** The profile starts: the dashboard goes first in its window, focused. */
    lead: serial(() => lead()),
    /** A window opened: the first normal one of the profile gets the dashboard. */
    windowOpened: serial(windowOpened),
  };
}
