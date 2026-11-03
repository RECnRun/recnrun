import { cdpHub, type CdpHub } from "./cdp-hub.ts";
import type { CdpTransport } from "./cdp-link.ts";
import { openCdpChannel, type CdpChannel } from "./cdp-socket.ts";
import { parseTargets } from "./handshake.ts";
import {
  connectBrowser as connectPlaywright,
  linkOver,
  type ConnectedBrowser,
} from "./playwright-transport.ts";

/** The service's connections to Chrome: one socket and one Playwright connection per endpoint. */
export interface SharedChrome {
  /** A lane on the Chrome at `endpoint`; the first one opens the socket. */
  lane(endpoint: string): Promise<CdpChannel>;
  /** The replay transport: links share one Playwright connection per Chrome. */
  readonly transport: CdpTransport;
  /** Closes every socket and Playwright connection; nothing opens afterwards. */
  close(): Promise<void>;
}

export interface ShareOptions {
  openChannel?: (endpoint: string) => Promise<CdpChannel>;
  connectBrowser?: (endpoint: string) => Promise<ConnectedBrowser>;
}

const NONE = { targetInfos: [] };

/** A value opened on first use and, once `watch` reports it lost, opened again on the next. */
class Reopening<T> {
  private current: Promise<T> | undefined;
  private readonly open: () => Promise<T>;
  private readonly watch: (value: T, lost: () => void) => void;

  constructor(open: () => Promise<T>, watch: (value: T, lost: () => void) => void) {
    this.open = open;
    this.watch = watch;
  }

  get(): Promise<T> {
    if (!this.current) {
      const opening = this.open().then((value) => {
        this.watch(value, () => this.forget(opening));
        return value;
      });
      opening.catch(() => this.forget(opening));
      this.current = opening;
    }
    return this.current;
  }

  held(): boolean {
    return this.current !== undefined;
  }

  async close(dispose: (value: T) => void | Promise<void>): Promise<void> {
    const current = this.current;
    this.current = undefined;
    if (current) await current.then(dispose).catch(() => undefined);
  }

  private forget(which: Promise<T>): void {
    if (this.current === which) this.current = undefined;
  }
}

function chromeAt(endpoint: string, options: Required<ShareOptions>) {
  return {
    hub: new Reopening<CdpHub>(
      () => options.openChannel(endpoint).then(cdpHub),
      (hub, lost) => hub.onClose(lost),
    ),
    browser: new Reopening<ConnectedBrowser>(
      () => options.connectBrowser(endpoint),
      (browser, lost) => browser.on("disconnected", lost),
    ),
  };
}

type Chrome = ReturnType<typeof chromeAt>;

async function preflight({ hub, browser }: Chrome): Promise<unknown> {
  // Once Playwright holds this Chrome, every page reads attached; none of it is contested.
  if (browser.held()) return NONE;
  const shared = await hub.get();
  const held = shared.held();
  const targets = parseTargets(await shared.send("Target.getTargets"));
  return { targetInfos: targets.filter(({ targetId }) => !held.has(targetId)) };
}

/**
 * Holds one browser-level socket and one Playwright connection per Chrome for the service's
 * lifetime, since Chrome asks the person to allow each new socket: recording, picker, and replay
 * evidence ride lanes of the socket, and every replay's link rides the Playwright connection.
 */
export function shareChrome(options: ShareOptions = {}): SharedChrome {
  const deps = {
    openChannel: options.openChannel ?? openCdpChannel,
    connectBrowser: options.connectBrowser ?? connectPlaywright,
  };
  const chromes = new Map<string, Chrome>();
  let closed = false;
  const chrome = (endpoint: string): Chrome => {
    if (closed) throw new Error("The connections to Chrome are closed.");
    let entry = chromes.get(endpoint);
    if (!entry) {
      entry = chromeAt(endpoint, deps);
      chromes.set(endpoint, entry);
    }
    return entry;
  };
  return {
    lane: async (endpoint) => (await chrome(endpoint).hub.get()).lane(),
    transport: {
      preflightTargets: (endpoint) => preflight(chrome(endpoint)),
      open: async (endpoint) =>
        linkOver(await chrome(endpoint).browser.get(), () => Promise.resolve()),
    },
    async close() {
      closed = true;
      const entries = [...chromes.values()];
      chromes.clear();
      await Promise.all(
        entries.flatMap(({ hub, browser }) => [
          hub.close((opened) => opened.close()),
          browser.close((connected) => connected.close()),
        ]),
      );
    },
  };
}
