import { chromium, type CDPSession } from "playwright-core";
import type { CdpLink, CdpTransport, PageSession } from "./cdp-link.ts";
import { rawCdpCall } from "./raw-cdp.ts";

const CONNECT_TIMEOUT_MS = 15_000;

type RawSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

// Playwright types `send` per protocol method; the adapter sends methods by name.
const rawSend = (session: CDPSession): RawSend => session.send.bind(session) as unknown as RawSend;

/** The production transport: a raw preflight socket, then Playwright `connectOverCDP`. */
export const playwrightTransport: CdpTransport = {
  preflightTargets: (endpoint) => rawCdpCall(endpoint, "Target.getTargets"),
  async open(endpoint): Promise<CdpLink> {
    const browser = await chromium.connectOverCDP(endpoint, { timeout: CONNECT_TIMEOUT_MS });
    const session = await browser.newBrowserCDPSession();
    return {
      send: rawSend(session),
      async pageSession(): Promise<PageSession | undefined> {
        const page = browser.contexts().flatMap((context) => context.pages())[0];
        if (!page) return undefined;
        const pageSession = await page.context().newCDPSession(page);
        return { send: rawSend(pageSession), detach: () => pageSession.detach() };
      },
      onDisconnected: (listener) => browser.on("disconnected", () => listener()),
      close: () => browser.close(),
    };
  },
};
