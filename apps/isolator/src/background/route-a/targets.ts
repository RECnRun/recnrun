import type { TargetInfo } from "@/background/probes/types";
import type { JournalEntry, UnattachedTarget } from "@/background/route-a/types";

export function originOf(url: string): string | undefined {
  const origin = URL.canParse(url) ? new URL(url).origin : "null";
  return origin === "null" ? undefined : origin;
}

/** Worker targets on an armed tab's origin that no auto-attach or direct attach reached. */
export function unattachedOf(
  targets: TargetInfo[],
  tabIds: number[],
  entries: JournalEntry[],
): UnattachedTarget[] {
  const pages = targets.filter((target) => target.type === "page");
  const origins = new Set(
    pages.filter((page) => tabIds.includes(page.tabId ?? -1)).map((page) => originOf(page.url)),
  );
  origins.delete(undefined);
  const seen = new Set(entries.map((entry) => entry.targetId));
  return targets
    .filter((target) => target.type !== "page" && !seen.has(target.id))
    .filter((target) => origins.has(originOf(target.url)))
    .map(({ id, type, url }) => ({ targetId: id, type, url }));
}
