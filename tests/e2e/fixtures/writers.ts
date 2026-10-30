import type { Page } from "@playwright/test";
import type { WriterBeacon, WritersFirst } from "../apps/writer-pages.ts";
import { appLog } from "./app.ts";
import { expect } from "./extension.ts";
import type { JournalMark } from "./lifecycle.ts";

/** The three writers; `mirror` is the page writer's second database. */
const WRITERS = ["page", "worker", "sw"] as const;

interface WritersWindow {
  __writers: { first: Promise<WritersFirst>; start: (tag: string) => Promise<void> };
}

/** What the page read before any writer ran in it. */
export async function firstReads(page: Page): Promise<WritersFirst> {
  await page.waitForFunction(() => "__writers" in window);
  return page.evaluate(() => (window as unknown as WritersWindow).__writers.first);
}

/** Starts the page, worker, and Service Worker writers under `tag`. */
export const startWriters = (page: Page, tag: string) =>
  page.evaluate((each) => (window as unknown as WritersWindow).__writers.start(each), tag);

/** Every write the writers reported for `run`, in arrival order. */
export async function beacons(run: string): Promise<WriterBeacon[]> {
  return (await appLog(run))
    .filter(({ kind }) => kind === "report")
    .map(({ body }) => body as WriterBeacon)
    .filter((body) => typeof body.writer === "string");
}

/** Waits until each writer reported `count` writes under `tag`. */
export async function writing(run: string, tag: string, count = 20): Promise<void> {
  await expect
    .poll(
      async () => {
        const sent = await beacons(run);
        return Math.min(
          ...WRITERS.map(
            (writer) => sent.filter((each) => each.writer === writer && each.tag === tag).length,
          ),
        );
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThanOrEqual(count);
}

/** When one operation began capturing, began persisting (the capture was published), and began closing. */
export interface Cutoff {
  capture: number;
  persist: number;
  close: number;
}

/** The cutoff of the one operation among `marks` that captured. */
export function cutoffOf(marks: readonly JournalMark[]): Cutoff {
  const at = (step: string) => {
    const found = marks.find((mark) => mark.step === step && mark.status === "running");
    if (!found) throw new Error(`No ${step} step in the journal.`);
    return found.at;
  };
  return { capture: at("capture"), persist: at("persist"), close: at("close") };
}

/** Per writer: what came back, what it reported, and what it lost after the cutoff. */
export interface WriterOutcome {
  restored: number;
  reported: number;
  lost: number;
  duringCapture: number;
  afterCommit: number;
}

/**
 * Each database is one consistent snapshot of `identity`'s writes: its max key and `meta` agree.
 * A writer's own database also has no gap; the mirror takes its keys from the page's database,
 * so one captured a write later than the other leaves a gap once the page writes again.
 */
function checkDatabases(first: WritersFirst, identity: string): void {
  for (const writer of [...WRITERS, "mirror"]) {
    const read = first.databases[writer];
    expect(read?.meta?.seq, writer).toBe(read?.max);
    expect(
      read?.tags.every((tag) => tag.startsWith(`${identity}:`)),
      writer,
    ).toBe(true);
    if (writer === "mirror") continue;
    expect(read, writer).toMatchObject({ contiguous: true });
    expect(read?.count, writer).toBe(read?.max);
  }
}

/** Every write committed before the capture began came back, and none committed after it was published. */
function outcomeOf(restored: number, mine: readonly WriterBeacon[], cutoff: Cutoff): WriterOutcome {
  const before = mine.filter(({ committed }) => committed < cutoff.capture);
  const after = mine.filter(({ committed }) => committed > cutoff.persist);
  expect(before.every(({ seq }) => seq <= restored)).toBe(true);
  expect(after.every(({ seq }) => seq > restored)).toBe(true);
  const reported = Math.max(...mine.map(({ seq }) => seq));
  const during = mine.filter(
    ({ committed }) => committed >= cutoff.capture && committed <= cutoff.persist,
  );
  return {
    restored,
    reported,
    lost: reported - restored,
    duringCapture: during.length,
    afterCommit: after.length,
  };
}

/** One restored session: what the page read first, whose it is, and the session tag it saved. */
export interface Restored {
  first: WritersFirst;
  identity: string;
  session: string;
}

/** Checks one restored identity against what its writers reported before the cutoff. */
export function checkRestore(
  { first, identity, session }: Restored,
  sent: readonly WriterBeacon[],
  cutoff: Cutoff,
): Record<string, WriterOutcome> {
  checkDatabases(first, identity);
  const outcomes: Record<string, WriterOutcome> = {};
  for (const writer of WRITERS) {
    const mine = sent.filter((each) => each.writer === writer && each.tag === session);
    outcomes[writer] = outcomeOf(first.databases[writer]?.max ?? 0, mine, cutoff);
  }
  return outcomes;
}
