import type { TabList } from "@recnrun/engine";
import type { ReplayPage } from "./replay-page.ts";

/** The replay's own tabs: the ones it opened and the popups they opened, in that order. */
export interface ReplayTabs {
  /** The tab replay acts on; the first call opens one in the default browser context. */
  current(): Promise<ReplayPage>;
  /** The tab replay acts on, without opening one. */
  selected(): ReplayPage | undefined;
  list(): Promise<TabList>;
  /** Opens a new tab and acts on it from now on. */
  open(): Promise<ReplayPage>;
  /** False when no open tab has that index. */
  select(index: number): Promise<boolean>;
  /** Closes the tab replay acts on; the last tab still open becomes the current one. */
  close(): Promise<void>;
}

async function describe(open: ReplayPage[], chosen: ReplayPage | undefined): Promise<TabList> {
  // A title cannot be read while its page navigates; the URL is enough to tell tabs apart.
  const tabs = await Promise.all(
    open.map(async (page) => ({ url: page.url(), title: await page.title().catch(() => "") })),
  );
  const index = chosen ? open.indexOf(chosen) : -1;
  return { tabs, current: index === -1 ? null : index };
}

/** `open` failing leaves the next call to open the tab again. */
export function createTabs(open: () => Promise<ReplayPage>): ReplayTabs {
  const pages: ReplayPage[] = [];
  let chosen: ReplayPage | undefined;
  let opening: Promise<ReplayPage> | undefined;
  const live = () => pages.filter((page) => !page.isClosed());
  const forget = (page: ReplayPage) => {
    const index = pages.indexOf(page);
    if (index !== -1) pages.splice(index, 1);
    if (chosen === page) chosen = live().at(-1);
  };
  const track = (page: ReplayPage): ReplayPage => {
    pages.push(page);
    page.on("popup", (popup) => void track(popup));
    page.on("close", () => forget(page));
    return page;
  };
  const openTab = async () => {
    chosen = track(await open());
    return chosen;
  };
  const selected = () => (chosen && !chosen.isClosed() ? chosen : undefined);
  return {
    current() {
      const page = selected();
      if (page) return Promise.resolve(page);
      opening ??= openTab().finally(() => {
        opening = undefined;
      });
      return opening;
    },
    selected,
    list: () => describe(live(), chosen),
    open: openTab,
    async select(index) {
      const page = live()[index];
      if (!page) return false;
      await page.bringToFront();
      chosen = page;
      return true;
    },
    async close() {
      const page = selected();
      if (!page) return;
      await page.close();
      forget(page);
    },
  };
}
