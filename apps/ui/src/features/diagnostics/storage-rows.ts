import { type Event, StorageEventSchema } from "@recnrun/protocol";
import { type Output, check } from "@/api/schema";
import { timeOf } from "@/features/diagnostics/rows";

type StorageEvent = Output<typeof StorageEventSchema>;
type Observation = StorageEvent["payload"]["observation"];
type Of<T extends StorageEvent["type"]> = Extract<StorageEvent, { type: T }>["payload"];

/** How the capture knows what it reports, in words; a snapshot is no proof of who changed what. */
const OBSERVATIONS: Record<Observation, string> = {
  snapshot: "snapshot",
  "observed-change": "observed change",
  "observed-operation": "observed operation",
};

export interface StorageRow {
  key: string;
  time: string;
  type: string;
  observation: string;
  detail: string;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function operation({ area, operation: call, key, value, error }: Of<"operation">): string {
  const args = [key, value].filter((arg) => arg !== undefined).join(", ");
  return `${area}Storage.${call}(${args})${error ? ` threw ${error}` : ""}`;
}

// A cookie the capture may not read keeps no value; the row says so instead of showing one.
const cookie =
  (verb: string) =>
  ({ cookie: { name, redacted } }: Of<"cookie-added">) =>
    `cookie ${name} ${verb}${redacted ? " (value redacted)" : ""}`;

const DETAILS: { [T in StorageEvent["type"]]: (payload: Of<T>) => string } = {
  snapshot: ({ area, storageKey, items }) =>
    `${area} ${storageKey}: ${plural(items.length, "item")}`,
  "item-added": ({ area, key, newValue }) => `${area} ${key} = ${newValue}`,
  "item-updated": ({ area, key, oldValue, newValue }) =>
    `${area} ${key}: ${oldValue} → ${newValue}`,
  "item-removed": ({ area, key }) => `${area} ${key} removed`,
  "items-cleared": ({ area }) => `${area} cleared`,
  operation,
  "cookies-snapshot": ({ cookies }) => plural(cookies.length, "cookie"),
  "cookie-added": cookie("added"),
  "cookie-changed": cookie("changed"),
  "cookie-removed": cookie("removed"),
};

const detailOf = ({ type, payload }: StorageEvent) =>
  (DETAILS[type] as (payload: StorageEvent["payload"]) => string)(payload);

/** The run's storage events that parse, in journal order, each with its transaction state. */
export function storageRows(events: readonly Event[]): StorageRow[] {
  return events.flatMap((event) => {
    if (event.category !== "storage") return [];
    const parsed = check(StorageEventSchema, event);
    if (!parsed.ok) return [];
    return [
      {
        key: event.id,
        time: timeOf(event),
        type: event.type,
        observation: OBSERVATIONS[parsed.value.payload.observation],
        detail: detailOf(parsed.value),
      },
    ];
  });
}
