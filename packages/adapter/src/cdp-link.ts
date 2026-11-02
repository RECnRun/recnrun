/** One CDP session: the browser target's or a page's. */
export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface PageSession extends CdpSession {
  detach(): Promise<void>;
}

/** A live browser connection; Playwright provides it, unit tests fake it. */
export interface CdpLink extends CdpSession {
  /** A fresh session on an open page, or undefined when no page is open. */
  pageSession(): Promise<PageSession | undefined>;
  onDisconnected(listener: () => void): void;
  close(): Promise<void>;
}

/** How a connection reaches Chrome; injectable so unit tests need no browser. */
export interface CdpTransport {
  /** `Target.getTargets` over a raw browser session, before anything of ours attaches to a page. */
  preflightTargets(endpoint: string): Promise<unknown>;
  open(endpoint: string): Promise<CdpLink>;
}
