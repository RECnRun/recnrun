import { useEffect, useState } from "preact/hooks";
import type { BrowserTabs, TabSource } from "@/tabs/open-tabs";

/**
 * The browser's tabs, or `undefined` until first read. A burst of tab events reads them once more
 * after the read in flight, and a read that changes nothing shown keeps the state.
 */
export function useBrowserTabs(source: TabSource): BrowserTabs | undefined {
  const [state, setState] = useState<BrowserTabs>();
  useEffect(() => {
    let live = true;
    let reading = false;
    let again = false;
    let shown = "";
    const show = (next: BrowserTabs) => {
      const key = JSON.stringify(next);
      if (!live || key === shown) return;
      shown = key;
      setState(next);
    };
    const refresh = (): void => {
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      void source
        .read()
        .then(show, () => {})
        .finally(() => {
          reading = false;
          if (!again || !live) return;
          again = false;
          refresh();
        });
    };
    refresh();
    const unwatch = source.watch(refresh);
    return () => {
      live = false;
      unwatch();
    };
  }, [source]);
  return state;
}
