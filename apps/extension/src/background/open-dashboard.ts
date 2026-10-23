interface Sender {
  id?: string;
  url?: string;
  tab?: { id?: number };
}

interface OpenDashboardDependencies {
  extensionId: string;
  isAllowedPage: (url: string) => boolean;
  openInTab: (tabId: number) => Promise<unknown>;
}

/** POC: moves the sending recnrun.com tab to the extension dashboard. */
export function createOpenDashboardListener({
  extensionId,
  isAllowedPage,
  openInTab,
}: OpenDashboardDependencies) {
  return (message: unknown, sender: Sender): false => {
    const isOpen = (message as { type?: unknown } | null)?.type === "openDashboard";
    const tabId = sender.tab?.id;
    if (!isOpen || sender.id !== extensionId || tabId === undefined) return false;
    if (sender.url === undefined || !isAllowedPage(sender.url)) return false;
    void openInTab(tabId);
    return false;
  };
}

/** Same origins as the content-script match patterns (`scheme://host/*`, any port). */
export function matchesOrigins(patterns: string[]): (url: string) => boolean {
  const allowed = patterns.map((pattern) => new URL(pattern.replace("/*", "/")));
  return (url) => {
    const page = new URL(url);
    return allowed.some(
      (origin) => origin.protocol === page.protocol && origin.hostname === page.hostname,
    );
  };
}
