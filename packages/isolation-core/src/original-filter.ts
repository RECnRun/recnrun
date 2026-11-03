import { nameOf } from "./marker-patches.ts";
import { RESERVED_PREFIX } from "./marker.ts";

/** Whether `name` is a physical name of a namespaced session, which the original session never sees. */
export function isReservedName(name: unknown): boolean {
  return String(name).startsWith(RESERVED_PREFIX);
}

/** `entries` (names, or objects with a `name`) without the namespaced ones. */
export function visibleToOriginal(entries: unknown): unknown[] {
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry: unknown) => !isReservedName(nameOf(entry)));
}

/** What the original session gets when page code names a store with the reserved prefix itself. */
export function reservedNameRefusal(api: string, name: unknown): DOMException {
  const message = `RECnRun refused ${api}("${String(name)}"): names that start with "${RESERVED_PREFIX}" are reserved`;
  return new DOMException(message, "SecurityError");
}
