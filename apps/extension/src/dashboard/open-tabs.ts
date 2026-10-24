import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";

/** A browser tab the dashboard can record. */
export interface OpenTab {
  id: number;
  title: string;
  url: string;
}

/** The browser's tabs, kept current, injected so component tests need no tabs API. */
export interface TabSource {
  list: () => Promise<OpenTab[]>;
  /** Calls back when a tab opens, closes, moves, or changes; returns the unsubscribe function. */
  watch: (onChange: () => void) => () => void;
}

/** Every tab with an id, titled by its address when it has no title. */
export function toOpenTabs(tabs: readonly Browser.tabs.Tab[]): OpenTab[] {
  return tabs.flatMap(({ id, title, url = "" }) =>
    id === undefined ? [] : [{ id, title: title || url, url }],
  );
}

const TAB_EVENTS = ["onCreated", "onUpdated", "onRemoved", "onMoved", "onAttached"] as const;

export function browserTabs(): TabSource {
  return {
    list: async () => toOpenTabs(await browser.tabs.query({})),
    watch: (onChange) => {
      const listener = () => onChange();
      for (const event of TAB_EVENTS) browser.tabs[event].addListener(listener);
      return () => {
        for (const event of TAB_EVENTS) browser.tabs[event].removeListener(listener);
      };
    },
  };
}
