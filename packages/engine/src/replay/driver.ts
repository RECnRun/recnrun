import type { AdapterEvent, CapturedEvent, Target } from "@recnrun/protocol";
import type { ReplayBlobs } from "./record.ts";

/** What a target matches now; the element fields describe the match only when `count` is 1. */
export interface ElementState {
  count: number;
  visible: boolean;
  enabled: boolean;
  editable: boolean;
  /** The element's text content; "" when it has none. */
  text: string;
  /** The value of an input, textarea, or select; null for other elements. */
  value: string | null;
}

export interface TabInfo {
  url: string;
  title: string;
}

/** The replay's own tabs in the order they opened (popups included), and the one it acts on. */
export interface TabList {
  tabs: TabInfo[];
  /** Index into `tabs`; null before the first tab opens or after the last one closes. */
  current: number | null;
}

/** One write to the browser; the driver dispatches it at most once and never repeats it. */
export type DriverCommand =
  | { kind: "navigate"; url: string }
  | { kind: "reload" }
  | { kind: "click" | "check" | "uncheck"; target: Target }
  | { kind: "fill" | "type" | "select"; target: Target; value: string }
  | { kind: "keyPress"; key: string; target?: Target | undefined }
  | { kind: "scroll"; target?: Target | undefined; deltaX: number; deltaY: number }
  | { kind: "openTab"; url?: string | undefined }
  | { kind: "selectTab"; index: number }
  | { kind: "closeTab" };

/**
 * How a command ended. `not-dispatched` means nothing reached the page; `failed` means it was
 * dispatched and failed for a known reason; `unknown` means it was dispatched and its effect is
 * unknown (a timeout waiting for the navigation it started, a lost connection).
 */
export type ActResult =
  | { status: "done" }
  | { status: "not-dispatched" | "failed" | "unknown"; code: string; message: string };

/** One part of a page capture: its value, or why it could not be read. */
export type Captured<T> = { ok: true; value: T } | { ok: false; message: string };

/** The current tab's serialized HTML and screenshot; `tab` is false when the replay has none open. */
export type PageCapture =
  | { tab: false }
  | { tab: true; url: string; html: Captured<string>; screenshot: Captured<Uint8Array> };

export interface ReadOptions {
  /** How long one call may take; the executor polls reads again until its own deadline. */
  timeoutMs: number;
}

/** Where a replay's capture delivers: each event it observes, and the run's blobs for bodies. */
export interface CaptureSink {
  runId: string;
  /** Answers the event's durable write; the capture acknowledges the message only once it settles. */
  event(event: CapturedEvent): void | Promise<void>;
  /** Without it, bodies stay inline in their events. */
  blobs?: ReplayBlobs | undefined;
}

export interface CaptureHandle {
  /** Lets capture under way land in the sink, then stops it; nothing is delivered afterwards. */
  drain(): Promise<void>;
}

/** The browser operations the replay executor needs; `BrowserAdapter` has them. */
export interface ReplayDriver {
  /** Reads the target's state in the current tab; safe to repeat. */
  inspect(target: Target, options: ReadOptions): Promise<ElementState>;
  /** The attribute of the target's single match, or null when it has none; safe to repeat. */
  readAttribute(target: Target, name: string, options: ReadOptions): Promise<string | null>;
  /** The replay's tabs; safe to repeat. */
  tabs(options: ReadOptions): Promise<TabList>;
  /** Dispatches one write; the executor calls it once per step and never again for that step. */
  act(command: DriverCommand, options: ReadOptions): Promise<ActResult>;
  /** Captures the current tab for a snapshot; never opens a tab and never writes to the page. */
  capture?(options: ReadOptions): Promise<PageCapture>;
  /** Subscribes to the connection's events; the run journals a lost connection as a gap. */
  onEvent?(listener: (event: AdapterEvent) => void): () => void;
  /**
   * Captures what the replay's own tabs do (network, console and errors, storage, navigation),
   * as a recording session does at the normal level; tabs opened before the call are not captured.
   */
  onCapture?(sink: CaptureSink): Promise<CaptureHandle>;
}
