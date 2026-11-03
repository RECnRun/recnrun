import { launchChrome, test as base } from "./chrome.ts";
import type { StrictChrome } from "./chrome.ts";
import { ISOLATOR_PATH } from "./extension.ts";
import { preparePolicyInstall } from "./extension-loaders.ts";
import { keepDisplayOnFailure, until } from "./x-display.ts";

export { expect } from "./chrome.ts";

/*
 * The strict lab (E8): Chrome without any `--remote-debugging-*` flag, so no CDP client exists.
 * The isolator is force-installed by policy, configured through `chrome.storage.managed` (the
 * policy's `3rdparty.extensions.<id>.lab`), and posts its beacon and journal to this server at
 * `http://lab.localhost:<port>/lab`; Chrome resolves `*.localhost` to the loopback.
 */

const LOADED_TIMEOUT_MS = 30_000;

/** What the harness may set in the managed `lab` value (apps/isolator/src/background/lab/schema.ts). */
export interface LabSettings {
  marker?: string;
  arm?: {
    origin: string;
    pauseBeforeScript: boolean;
    route?: "a" | "b";
    clear?: boolean;
    urlPattern?: string;
    selection?: string;
  };
  selection?: { slot: number; origins: string[] };
  stop?: { id: string; origin: string };
  clear?: { id: string; tabId: number };
  pollMs?: number;
}

export interface LabTarget {
  type: string;
  id: string;
  url: string;
  attached: boolean;
  tabId?: number;
}

export interface LabLoaded {
  event: "loaded";
  id: string;
  version: string;
  timeOrigin: number;
  targets: LabTarget[];
}

export interface LabEntry {
  sessionId: string;
  targetId: string;
  type: string;
  url: string;
  waitingForDebugger: boolean;
  marker?: string;
  installed?: unknown;
  released: boolean;
  error?: string;
  pause?: { paused: boolean; laterPauses: number; typeofAtPause?: unknown };
}

export interface LabPage {
  tabId: number;
  url: string;
  marker: string;
  report: string | null;
  indexedDB: string[] | { error: string };
  cacheStorage: string[] | { error: string };
}

export interface LabJournal {
  event: "journal";
  seq: number;
  id: string;
  timeOrigin: number;
  targetsAtStart: LabTarget[];
  targets: LabTarget[];
  armed: {
    tabId: number;
    url: string;
    marker: string;
    route: string;
    cleared?: string;
    error?: string;
  }[];
  routeA: {
    marker?: string;
    entries: LabEntry[];
    unattached: unknown[];
    /** Target events and onDetach, in arrival order (apps/isolator/src/background/route-a/types.ts). */
    events?: Record<string, unknown>[];
    tabDetached?: { reason: string; at: number };
  };
  routeB: { workers: unknown[]; paused: unknown[]; tabs: unknown[] };
  pages: LabPage[];
  commands: { key: string; at: number; result: unknown }[];
  errors: string[];
}

/** What a timeout prints of the journal: no page bodies, no bootstrap steps. */
function summaryOf(journal: LabJournal | undefined): unknown {
  if (journal === undefined) return null;
  const { seq, armed, routeA, pages, commands, errors, targets } = journal;
  return {
    seq,
    armed,
    tabDetached: routeA.tabDetached,
    entries: routeA.entries.map(({ type, url, waitingForDebugger, released, error, pause }) => ({
      type,
      url,
      waitingForDebugger,
      released,
      error,
      paused: pause?.paused,
    })),
    unattached: routeA.unattached,
    pages: pages.map(({ url, report }) => [url, report?.length]),
    commands: commands.map(({ key }) => key),
    errors,
    targets: targets.map(({ type, url, attached }) => `${type} ${attached} ${url.slice(0, 60)}`),
  };
}

/** Keeps every beacon and the last journal the isolator posted. */
class LabSink {
  readonly loaded: LabLoaded[] = [];
  journal: LabJournal | undefined;
  /** Bodies that were neither, kept for the failure message. */
  readonly other: unknown[] = [];

  readonly receive = (body: unknown): void => {
    const event = (body as { event?: unknown } | null)?.event;
    if (event === "loaded") this.loaded.push(body as LabLoaded);
    else if (event === "journal") this.journal = body as LabJournal;
    else this.other.push(body);
  };

  /** Waits until the last journal satisfies `check`, and returns it. */
  async until(check: (journal: LabJournal) => boolean, what: string, ms = 15_000) {
    try {
      await until(async () => this.journal !== undefined && check(this.journal), what, ms);
    } catch (error) {
      // The journal is the only view into the browser, so a timeout carries it.
      const journal = JSON.stringify(summaryOf(this.journal));
      throw new Error(
        `${(error as Error).message}
Last journal: ${journal}`,
        { cause: error },
      );
    }
    return this.journal as LabJournal;
  }
}

export interface StrictExtension {
  method: "managed-policy";
  extensionId: string;
  chrome: StrictChrome;
  journalUrl: string;
  sink: LabSink;
  /** The managed `lab` value the policy file holds now. */
  lab(): LabSettings;
  /** Rewrites the policy with `settings` over the current value; Chrome reloads it on its own. */
  setLab(settings: LabSettings): Promise<void>;
  close(): Promise<void>;
}

export interface StrictOptions {
  lab?: LabSettings;
  /** `false` shows the debugger infobar (`launchChrome`'s `silentDebugger`). */
  silentDebugger?: boolean;
}

/** Force-installs the isolator by policy into Chrome without CDP and waits for its own beacon. */
async function installByPolicyStrict(
  path: string,
  { lab = {}, silentDebugger }: StrictOptions = {},
): Promise<StrictExtension> {
  const sink = new LabSink();
  const install = await preparePolicyInstall(path, { lab: sink.receive });
  const journalUrl = `http://lab.localhost:${install.port}/lab`;
  let current: LabSettings = lab;
  const write = (settings: LabSettings) =>
    install.writePolicy({
      // The fixture's push subscription waits on a notification prompt nobody answers.
      DefaultNotificationsSetting: 2,
      "3rdparty": { extensions: { [install.id]: { lab: { journalUrl, ...settings } } } },
    });
  let chrome: StrictChrome | undefined;
  const close = async (): Promise<void> => {
    await chrome?.close();
    await install.cleanup();
  };
  try {
    await write(current);
    const launched = await launchChrome({ cdp: false, silentDebugger });
    chrome = launched;
    const answered = async () => launched.exited() || sink.loaded.some((l) => l.id === install.id);
    await until(answered, "the isolator's loaded beacon", LOADED_TIMEOUT_MS).catch(() => undefined);
    if (!sink.loaded.some((loaded) => loaded.id === install.id)) {
      const seen = JSON.stringify([...sink.loaded, ...sink.other]).slice(0, 500);
      const served = install.requests.join(", ");
      throw new Error(
        `no loaded beacon from ${install.id} (got ${seen}; served ${served}):\n${launched.diagnostics()}`,
      );
    }
    const setLab = async (settings: LabSettings): Promise<void> => {
      current = { ...current, ...settings };
      await write(current);
    };
    const extension = {
      method: "managed-policy" as const,
      extensionId: install.id,
      chrome: launched,
    };
    return { ...extension, journalUrl, sink, lab: () => current, setLab, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** A browser-layer test with the strict lab; `strictOptions` sets the first managed value. */
export const test = base.extend<{ strictOptions: StrictOptions; strict: StrictExtension }>({
  strictOptions: [{}, { option: true }],
  strict: async ({ headless, strictOptions }, use, testInfo) => {
    if (headless) throw new Error("Browser tests run Chrome headed; set use.headless to false.");
    const strict = await installByPolicyStrict(ISOLATOR_PATH, strictOptions);
    try {
      await use(strict);
    } finally {
      // Before Chrome closes, so a failure keeps what its windows showed.
      await keepDisplayOnFailure(testInfo).catch(() => undefined);
      await strict.close();
    }
  },
});
