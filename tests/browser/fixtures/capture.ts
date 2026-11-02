import type { Frame, Page } from "@playwright/test";
import { instrument, type Instrumentation } from "../../../packages/adapter/src/index.ts";
import {
  openJournal,
  readJournal,
  type JournalContents,
} from "../../../packages/persistence/src/index.ts";
import type { CapturedEvent, DomPayload } from "../../../packages/protocol/src/index.ts";
import { expect, test as appTest } from "./fixture-app.ts";

export { expect };

export interface Captured {
  handle: Instrumentation;
  events: CapturedEvent[];
  /** The hook's document id for this page or frame, once its install was captured. */
  documentOf(context: Page | Frame): Promise<string>;
  /** The target id the hook of this page or frame reported through. */
  targetOf(context: Page | Frame): Promise<string>;
  /** Stops the capture, waits for every journal line, and reads the journal back. */
  finish(): Promise<JournalContents>;
}

// Short enough that the slow stream (10 chunks, 1.5 s apart) is still loading when it passes.
export const BODY_TIMEOUT_MS = 2_000;

declare global {
  interface Window {
    __recnrunHook?: { version: number; installedAt: number; documentId: string };
  }
}

export const test = appTest.extend<{ captured: Captured }>({
  captured: async ({ app, chrome }, use, testInfo) => {
    void app;
    const events: CapturedEvent[] = [];
    const path = testInfo.outputPath("events.jsonl");
    const journal = await openJournal(path);
    const writes: Promise<void>[] = [];
    const handle = await instrument(chrome.wsEndpoint, {
      capture: {
        runId: "capture-spec",
        bodyTimeoutMs: BODY_TIMEOUT_MS,
        onEvent: (event) => {
          events.push(event);
          writes.push(journal.append(event));
        },
      },
    });
    let finished: Promise<JournalContents> | undefined;
    const finish = () => {
      finished ??= (async () => {
        await handle.settled();
        handle.stop();
        await Promise.all(writes);
        await journal.close();
        return readJournal(path);
      })();
      return finished;
    };
    const installOf = async (context: Page | Frame) => {
      const id = (await context.evaluate(() => window.__recnrunHook?.documentId)) ?? "";
      const hooked = () =>
        events.find((event) => event.type === "hook-installed" && event.documentId === id);
      await expect.poll(() => hooked()).toBeDefined();
      return hooked() as CapturedEvent;
    };
    try {
      await use({
        handle,
        events,
        documentOf: async (context) => (await installOf(context)).documentId ?? "",
        targetOf: async (context) => (await installOf(context)).targetId ?? "",
        finish,
      });
    } finally {
      await finish();
      await testInfo.attach("report", { body: JSON.stringify(handle.report(), null, 2) });
      await testInfo.attach("events.jsonl", { path, contentType: "application/x-ndjson" });
    }
  },
});

const DETAILS = ["key", "inputType", "data", "value", "checked", "redacted"] as const;

/** A DOM event by its stable fields only: type, target, and what was typed or chosen. */
export function project(event: CapturedEvent): string {
  if (event.category !== "dom") return "";
  const payload = event.payload as Partial<DomPayload> & Record<string, unknown>;
  const target = payload.target ? (payload.target.testId ?? payload.target.tag) : "";
  const parts: string[] = [event.type, target];
  for (const key of DETAILS)
    if (payload[key] !== undefined) parts.push(`${key}=${JSON.stringify(payload[key])}`);
  if (typeof payload.dialogType === "string") parts.push(`dialogType=${payload.dialogType}`);
  if (typeof payload.result === "boolean") parts.push(`result=${payload.result}`);
  return parts.filter(Boolean).join(" ");
}

/** The network events of every request whose URL (at any hop) contains `path`. */
export function requestsTo(events: CapturedEvent[], path: string): CapturedEvent[][] {
  const network = events.filter((event) => event.category === "network");
  const keys = new Set(
    network
      .filter((event) => String((event.payload as { url?: string }).url ?? "").includes(path))
      .map((event) => `${event.source}/${String(event.payload.requestId)}`),
  );
  return [...keys].map((key) =>
    network.filter((event) => `${event.source}/${String(event.payload.requestId)}` === key),
  );
}

export const payloadOf = (
  events: CapturedEvent[],
  type: string,
): Record<string, unknown> | undefined => events.find((event) => event.type === type)?.payload;
