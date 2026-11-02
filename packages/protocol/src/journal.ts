import * as v from "valibot";
import { EventSchema, type Event } from "./events.ts";

/** The journal of a run, one event per line (source plan §12). */
export const JOURNAL_FILE = "events.jsonl";

export type ParsedJournalEvent = { ok: true; event: Event } | { ok: false; message: string };

/** Validates one journal event for code that does not import Valibot (persistence). */
export function parseJournalEvent(value: unknown): ParsedJournalEvent {
  const parsed = v.safeParse(EventSchema, value);
  if (parsed.success) return { ok: true, event: parsed.output };
  return { ok: false, message: v.summarize(parsed.issues) };
}
