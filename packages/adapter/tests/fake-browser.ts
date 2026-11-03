import type { ConnectedBrowser } from "../src/playwright-transport.ts";
import type { ReplayPage } from "../src/replay.ts";
import { fakePage, VERSION } from "./fake-cdp.ts";

/** Playwright's view of one Chrome: browser sessions, the default context's pages, `disconnected`. */
export class FakeBrowser {
  readonly calls: string[] = [];
  readonly pages: ReplayPage[] = [];
  closed = false;
  detached = 0;
  private readonly listeners = new Set<() => void>();

  newBrowserCDPSession() {
    return Promise.resolve(this.session("browser"));
  }

  contexts() {
    return [this.context()];
  }

  newContext() {
    return Promise.resolve(this.context());
  }

  on(_event: string, listener: () => void) {
    this.listeners.add(listener);
    return this;
  }

  off(_event: string, listener: () => void) {
    this.listeners.delete(listener);
    return this;
  }

  close() {
    this.closed = true;
    this.disconnect();
    return Promise.resolve();
  }

  /** Chrome went away: Playwright reports it as `disconnected`. */
  disconnect() {
    for (const listener of this.listeners) listener();
  }

  asBrowser(): ConnectedBrowser {
    return this as unknown as ConnectedBrowser;
  }

  private session(scope: string) {
    return {
      send: (method: string) => {
        this.calls.push(`${scope} ${method}`);
        if (method === "Browser.getVersion") return Promise.resolve(VERSION);
        return Promise.resolve(method === "Target.getTargets" ? { targetInfos: [] } : {});
      },
      detach: () => {
        this.detached += 1;
        return Promise.resolve();
      },
    };
  }

  private context() {
    return {
      pages: () => this.pages,
      newPage: () => {
        this.calls.push("browser openPage");
        const page = Object.assign(fakePage(this.calls), { context: () => this.context() });
        this.pages.push(page);
        return Promise.resolve(page);
      },
      newCDPSession: () => Promise.resolve(this.session("page")),
    };
  }
}
