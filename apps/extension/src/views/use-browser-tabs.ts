import { useEffect, useState } from "preact/hooks";
import type { BrowserTabs, TabSource } from "@/ports/tabs";
import { coalesceReads } from "@/views/coalesce-reads";

/**
 * The browser's tabs, or `undefined` until first read. A burst of tab events reads them once more
 * after the read in flight, and a read that changes nothing shown keeps the state.
 */
export function useBrowserTabs(source: TabSource): BrowserTabs | undefined {
  const [state, setState] = useState<BrowserTabs>();
  useEffect(() => {
    let shown = "";
    const reads = coalesceReads(
      () => source.read(),
      (next) => {
        const key = JSON.stringify(next);
        if (key === shown) return;
        shown = key;
        setState(next);
      },
    );
    reads.refresh();
    const unwatch = source.watch(reads.refresh);
    return () => {
      reads.stop();
      unwatch();
    };
  }, [source]);
  return state;
}
