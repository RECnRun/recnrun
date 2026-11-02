import {
  RECORDER_OVERLAY_PREFIX,
  type CapturedEvent,
  type DomEventType,
  type EventRef,
} from "@recnrun/protocol";

export type DomEvent = Extract<CapturedEvent, { category: "dom"; type: DomEventType }>;
export type NavigationEvent = Extract<CapturedEvent, { category: "navigation" }>;
export type DomTarget = DomEvent["payload"]["target"];

export interface NormalizeOptions {
  /** Actor names by producer (the session) and by profile binding; the producer wins. */
  actors?: { producers?: Record<string, string>; bindings?: Record<string, string> };
  /** The replay command ids to exclude; without it, every event with a `commandId` is replay-caused. */
  replayCommandIds?: readonly string[];
  /** Keeps every scroll as a step instead of applying the scroll policy. */
  keepScrolls?: boolean;
  dblclickWindowMs?: number;
  navigationWindowMs?: number;
  /** Test ids and ids starting with this belong to the recorder overlay. */
  overlayPrefix?: string;
}

export interface Settings {
  producers: Record<string, string>;
  bindings: Record<string, string>;
  replayCommandIds: ReadonlySet<string> | undefined;
  keepScrolls: boolean;
  dblclickWindowMs: number;
  navigationWindowMs: number;
  overlayPrefix: string;
}

export function settle(options: NormalizeOptions): Settings {
  return {
    producers: options.actors?.producers ?? {},
    bindings: options.actors?.bindings ?? {},
    replayCommandIds: options.replayCommandIds ? new Set(options.replayCommandIds) : undefined,
    keepScrolls: options.keepScrolls ?? false,
    dblclickWindowMs: options.dblclickWindowMs ?? 500,
    navigationWindowMs: options.navigationWindowMs ?? 2000,
    overlayPrefix: options.overlayPrefix ?? RECORDER_OVERLAY_PREFIX,
  };
}

interface DraftBase {
  events: CapturedEvent[];
  /** The element identity of the target (producer, frame, and attributes) for merging. */
  targetKey?: string;
}

/** A step under construction, before ids, actors, and locators are assigned. */
export type Draft = DraftBase &
  (
    | { action: "navigate"; url: string }
    | { action: "click" | "dblclick"; target: DomTarget }
    | { action: "drag"; target: DomTarget; to: DomTarget }
    | { action: "fill" | "type" | "select"; target: DomTarget; value: string; redacted?: true }
    | { action: "keyPress"; key: string; target?: DomTarget }
    | { action: "scroll"; target?: DomTarget; scrollX: number; scrollY: number }
  );

export const timeOf = (event: CapturedEvent): number => Date.parse(event.timestamp);

export const startOf = (draft: Draft): number => Math.min(...draft.events.map(timeOf));

export const endOf = (draft: Draft): number => Math.max(...draft.events.map(timeOf));

export const refOf = (event: CapturedEvent): EventRef => ({
  id: event.id,
  producer: event.producer,
  seq: event.seq,
});

export const isDomEvent = (event: CapturedEvent): event is DomEvent =>
  event.category === "dom" && "target" in event.payload;

export function keyOf(event: DomEvent): string {
  const { tag, id, testId, name, role, inputType } = event.payload.target;
  return JSON.stringify([event.producer, event.frameId, tag, id, testId, name, role, inputType]);
}

const PAGE_TAGS = new Set(["#document", "#window", "html", "body"]);

/** The page itself is no target: replay sends keys and scrolls to the page without locating it. */
export const elementTarget = (target: DomTarget): DomTarget | undefined =>
  PAGE_TAGS.has(target.tag) ? undefined : target;
