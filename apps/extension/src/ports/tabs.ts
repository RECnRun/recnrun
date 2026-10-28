/** A browser tab, normal or incognito, as the dashboard lists it and the PiP window shows it. */
export interface OpenTab {
  id: number;
  windowId: number;
  incognito: boolean;
  title: string;
  url: string;
  /** Only an icon the extension can load without exposing the tab; see `tabs/open-tabs.ts`. */
  favicon?: string;
}

/** Every tab, and the active one of the focused browser window, if a browser window has the focus. */
export interface BrowserTabs {
  tabs: OpenTab[];
  currentId?: number;
}

/** The browser's tabs, kept current, injected so component tests need no tabs API. */
export interface TabSource {
  read: () => Promise<BrowserTabs>;
  /** Calls back when a tab or the focus changes; returns the unsubscribe function. */
  watch: (onChange: () => void) => () => void;
}

/** Whether the user allowed RECnRun in Incognito, where to allow it, and when windows come and go. */
export interface IncognitoAccess {
  allowed: () => Promise<boolean>;
  /** Opens RECnRun's details in chrome://extensions, where "Allow in Incognito" is. */
  openSettings: () => Promise<void>;
  /** Calls back when a window opens or closes; returns the unsubscribe function. */
  watchWindows: (onChange: () => void) => () => void;
}
