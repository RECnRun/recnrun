import { chromium, type Browser, type BrowserContext, type CDPSession } from "playwright-core";
import type { CdpLink, CdpTransport, PageSession } from "./cdp-link.ts";
import { assertLoopbackEndpoint } from "./loopback.ts";
import { rawCdpCall } from "./raw-cdp.ts";

const CONNECT_TIMEOUT_MS = 15_000;

type RawSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

// Playwright types `send` per protocol method; the adapter sends methods by name.
const rawSend = (session: CDPSession): RawSend => session.send.bind(session) as unknown as RawSend;

/** What a link needs of a Playwright browser connected over CDP; unit tests fake it. */
export interface ConnectedBrowser {
  newBrowserCDPSession(): Promise<CDPSession>;
  contexts(): BrowserContext[];
  newContext(): Promise<BrowserContext>;
  on(event: "disconnected", listener: (browser: Browser) => void): unknown;
  off(event: "disconnected", listener: (browser: Browser) => void): unknown;
  close(): Promise<void>;
}

/** Playwright `connectOverCDP` to a loopback endpoint. */
export function connectBrowser(endpoint: string): Promise<ConnectedBrowser> {
  assertLoopbackEndpoint(endpoint);
  return chromium.connectOverCDP(endpoint, { timeout: CONNECT_TIMEOUT_MS });
}

/**
 * A link over a connected browser: a browser CDP session of its own, closed with the link, which
 * then runs `release` (closing the browser, or nothing when the connection is shared).
 */
export async function linkOver(
  browser: ConnectedBrowser,
  release: () => Promise<void>,
): Promise<CdpLink> {
  const session = await browser.newBrowserCDPSession();
  const listeners = new Set<() => void>();
  const disconnected = () => {
    for (const listener of listeners) listener();
  };
  browser.on("disconnected", disconnected);
  return {
    send: rawSend(session),
    async pageSession(): Promise<PageSession | undefined> {
      const page = browser.contexts().flatMap((context) => context.pages())[0];
      if (!page) return undefined;
      const pageSession = await page.context().newCDPSession(page);
      return { send: rawSend(pageSession), detach: () => pageSession.detach() };
    },
    onDisconnected: (listener) => listeners.add(listener),
    async close() {
      browser.off("disconnected", disconnected);
      await session.detach().catch(() => undefined);
      await release();
    },
    async openPage() {
      const context = browser.contexts()[0] ?? (await browser.newContext());
      return context.newPage();
    },
  };
}

/** A connection of its own: a raw preflight socket, then Playwright, closed with the link. */
export const playwrightTransport: CdpTransport = {
  preflightTargets: (endpoint) => rawCdpCall(endpoint, "Target.getTargets"),
  async open(endpoint): Promise<CdpLink> {
    const browser = await connectBrowser(endpoint);
    return linkOver(browser, () => browser.close());
  },
};
