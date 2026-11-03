import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CDPSession, Page, TestInfo } from "@playwright/test";
import { redact } from "./redact.ts";
import { takeSnapshot } from "./storage.ts";
import type { StorageSnapshot } from "./storage.ts";

/** The evidence set of PLAN.md decision 7, one directory per test. */
const EVIDENCE_FILES = ["trace.jsonl", "ledger.json", "storage.json", "counters.json"];

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export interface ObserverOptions {
  /** A CDP session on the browser target, for `Target.*` events and the cookie list. */
  cdp: CDPSession;
  /** The page whose network, navigations, and console the trace records. */
  page: Page;
  runId: string;
  /** The directory under the run, `<spec>/<test>` (see `evidenceName`). */
  name: string;
  /** R9: runs on controls or on Playwright's Chromium are labelled; the decision ignores them. */
  label?: "diagnostic" | "control";
}

export interface Observer {
  readonly page: Page;
  readonly directory: string;
  start(): Promise<void>;
  snapshotStorage(origins: readonly string[], label?: string): Promise<void>;
  collectLedger(apiBase: string): Promise<void>;
  /** Writes the evidence set and returns its paths; later calls return the same paths. */
  finish(): Promise<string[]>;
}

interface CdpEvent {
  method: string;
  params?: object;
}

// The trace keeps requests, responses, targets, navigations, and console output; body chunks are noise.
function traced(method: string): boolean {
  if (method === "Network.dataReceived") return false;
  if (method.startsWith("Network.") || method.startsWith("Target.")) return true;
  return ["Page.frameNavigated", "Runtime.consoleAPICalled", "Runtime.exceptionThrown"].includes(
    method,
  );
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 80);
}

/** `<spec file without .spec.ts>/<test title>`, with the repeat and retry when there is one. */
export function evidenceName(testInfo: TestInfo): string {
  const spec = basename(testInfo.file).replace(/\.spec\.ts$/, "");
  const repeat = testInfo.repeatEachIndex > 0 ? `-repeat${testInfo.repeatEachIndex}` : "";
  const retry = testInfo.retry > 0 ? `-retry${testInfo.retry}` : "";
  return join(spec, `${slug(testInfo.title)}${repeat}${retry}`);
}

/** `RECNRUN_RUN_ID` (set once per run by the Playwright config) or a timestamp. */
export function currentRunId(): string {
  return process.env.RECNRUN_RUN_ID ?? new Date().toISOString().replaceAll(":", "-");
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(redact(value), null, 2)}\n`);
}

/**
 * A CDP observer that only inspects: it enables event domains, reads storage, and fetches the
 * fixture's ledger. Every value is redacted before it is kept (PLAN.md decisions 5 and 7).
 */
export function createObserver({ cdp, page, runId, name, label }: ObserverOptions): Observer {
  const directory = join(ROOT, ".artifacts/evidence", runId, name);
  const startedAt = new Date().toISOString();
  const trace: string[] = [];
  const snapshots: StorageSnapshot[] = [];
  let ledger: unknown[] = [];
  let product = "";
  let session: CDPSession | undefined;
  let written: Promise<string[]> | undefined;

  const record = (source: "browser" | "page") => (event: CdpEvent) => {
    if (!traced(event.method)) return;
    const line = { t: Date.now(), source, method: event.method, params: event.params ?? {} };
    trace.push(JSON.stringify(redact(line)));
  };
  const onBrowser = record("browser");
  const onPage = record("page");

  const requireSession = (): CDPSession => {
    if (!session) throw new Error("Call observer.start() first");
    return session;
  };

  const write = async (): Promise<string[]> => {
    cdp.off("event", onBrowser);
    await cdp.send("Target.setDiscoverTargets", { discover: false }).catch(() => undefined);
    await session?.detach().catch(() => undefined);
    await mkdir(directory, { recursive: true });
    const counters = {
      copiedBytes: 0,
      rulesInstalled: 0,
      switchTimings: [],
      run: { runId, name, chrome: product, labels: label ? [label] : [], startedAt },
      finishedAt: new Date().toISOString(),
      events: trace.length,
    };
    await writeFile(join(directory, "trace.jsonl"), trace.map((line) => `${line}\n`).join(""));
    await writeJson(join(directory, "ledger.json"), ledger);
    await writeJson(join(directory, "storage.json"), snapshots);
    await writeJson(join(directory, "counters.json"), counters);
    return EVIDENCE_FILES.map((file) => join(directory, file));
  };

  return {
    page,
    directory,
    async start() {
      product = (await cdp.send("Browser.getVersion")).product;
      cdp.on("event", onBrowser);
      await cdp.send("Target.setDiscoverTargets", { discover: true });
      session = await page.context().newCDPSession(page);
      session.on("event", onPage);
      await session.send("Network.enable");
      await session.send("Page.enable");
      await session.send("Runtime.enable");
      await session.send("DOMStorage.enable");
    },
    async snapshotStorage(origins, snapshotLabel) {
      const sessions = { page: requireSession(), browser: cdp };
      snapshots.push(redact(await takeSnapshot(sessions, origins, snapshotLabel)));
    },
    async collectLedger(apiBase) {
      const response = await fetch(`${apiBase}/__ledger`);
      if (!response.ok) throw new Error(`GET ${apiBase}/__ledger answered ${response.status}`);
      ledger = redact((await response.json()) as unknown[]);
    },
    finish() {
      written ??= write();
      return written;
    },
  };
}
