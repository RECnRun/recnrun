import type { CdpLink, CdpTransport, PageSession } from "../src/cdp-link.ts";
import type { ReplayPage } from "../src/replay.ts";

export const NOW = "2026-11-02T10:00:00.000Z";
export const now = (): Date => new Date(NOW);

export const VERSION = {
  protocolVersion: "1.3",
  product: "Chrome/156.0.8078.79",
  revision: "@93ce6b54",
  userAgent: "Mozilla/5.0 (X11; Linux aarch64) Chrome/156.0.0.0 Safari/537.36",
  jsVersion: "15.6.75.25",
};

export interface RawTarget {
  targetId: string;
  type: string;
  url: string;
  title: string;
  attached: boolean;
  [extra: string]: unknown;
}

export const page = (targetId: string, attached = false, url = "about:blank"): RawTarget => ({
  targetId,
  type: "page",
  url,
  title: "",
  attached,
  canAccessOpener: false,
  browserContextId: "C1",
});

/** What the fake Chrome answers; tests change it between calls. */
export interface FakeChrome {
  targets: RawTarget[];
  version: unknown;
  hasPage: boolean;
  missing: string[];
  failing: Record<string, string>;
  refuse: boolean;
}

export function fakeChrome(overrides: Partial<FakeChrome> = {}): FakeChrome {
  return {
    targets: [page("P1")],
    version: VERSION,
    hasPage: true,
    missing: [],
    failing: {},
    refuse: false,
    ...overrides,
  };
}

export class FakeLink implements CdpLink {
  readonly calls: string[] = [];
  closed = false;
  pageDetached = false;
  private readonly listeners: (() => void)[] = [];

  private readonly chrome: FakeChrome;
  readonly endpoint: string;

  constructor(chrome: FakeChrome, endpoint: string) {
    this.chrome = chrome;
    this.endpoint = endpoint;
  }

  send(method: string): Promise<unknown> {
    return this.answer("browser", method);
  }

  pageSession(): Promise<PageSession | undefined> {
    if (!this.chrome.hasPage) return Promise.resolve(undefined);
    return Promise.resolve({
      send: (method: string) => this.answer("page", method),
      detach: () => {
        this.pageDetached = true;
        return Promise.resolve();
      },
    });
  }

  onDisconnected(listener: () => void): void {
    this.listeners.push(listener);
  }

  /** Chrome went away: Playwright reports it as `disconnected`. */
  drop(): void {
    for (const listener of this.listeners) listener();
  }

  close(): Promise<void> {
    this.closed = true;
    // Playwright also emits `disconnected` when the client closes the connection itself.
    this.drop();
    return Promise.resolve();
  }

  private answer(scope: string, method: string): Promise<unknown> {
    this.calls.push(`${scope} ${method}`);
    if (this.chrome.missing.includes(method)) {
      return Promise.reject(new Error(`Protocol error (${method}): '${method}' wasn't found`));
    }
    const failure = this.chrome.failing[method];
    if (failure) return Promise.reject(new Error(`Protocol error (${method}): ${failure}`));
    if (method === "Browser.getVersion") return Promise.resolve(this.chrome.version);
    if (method === "Target.getTargets")
      return Promise.resolve({ targetInfos: this.chrome.targets });
    return Promise.resolve({});
  }

  openPage(): Promise<ReplayPage> {
    this.calls.push("browser openPage");
    return Promise.resolve(fakePage(this.calls));
  }
}

/** A replay tab that records the URLs it goes to in `calls`. */
export function fakePage(calls: string[]): ReplayPage {
  let at = "about:blank";
  const goto = (url: string) => {
    calls.push(`page goto ${url}`);
    at = url;
    return Promise.resolve(null);
  };
  const page = {
    goto,
    url: () => at,
    title: async () => "",
    isClosed: () => false,
    on: () => page,
  };
  return page as unknown as ReplayPage;
}

export function fakeTransport(chrome: FakeChrome): {
  transport: CdpTransport;
  links: FakeLink[];
  preflights: string[];
} {
  const links: FakeLink[] = [];
  const preflights: string[] = [];
  const transport: CdpTransport = {
    preflightTargets: (endpoint) => {
      preflights.push(endpoint);
      if (chrome.refuse) return Promise.reject(new Error("connect ECONNREFUSED"));
      return Promise.resolve({ targetInfos: chrome.targets });
    },
    open: (endpoint) => {
      if (chrome.refuse) return Promise.reject(new Error("connect ECONNREFUSED"));
      const link = new FakeLink(chrome, endpoint);
      links.push(link);
      return Promise.resolve(link);
    },
  };
  return { transport, links, preflights };
}
