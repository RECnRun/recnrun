import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/extension.ts";
import { keep } from "./fixtures/keep.ts";
import { lifecycleDriver, marksOf, nextPageAt, watchJournal } from "./fixtures/lifecycle.ts";
import {
  beacons,
  checkRestore,
  cutoffOf,
  firstReads,
  startWriters,
  writing,
} from "./fixtures/writers.ts";
import type { WriterOutcome } from "./fixtures/writers.ts";
import { APP } from "./fixtures/workspace.ts";

test.use({ incognitoAccess: true });

test("writers in the page, a worker, and a Service Worker never tear a capture or cross identities", async ({
  context,
  serviceWorker,
}) => {
  const run = `writers-${Date.now()}`;
  const url = `${APP}/writers/?run=${run}`;
  await watchJournal(serviceWorker);
  const { command } = await lifecycleDriver(context, serviceWorker);
  const ids: Record<string, string> = {};
  const created = async (label: string) => {
    const identity = (await command({ type: "workspace-new-identity", label, url })) as {
      id: string;
    };
    ids[label] = identity.id;
  };
  const outcomes: Record<string, Record<string, WriterOutcome>> = {};
  const skew: Record<string, unknown> = {};

  // A opens empty and writes; New identity B captures A while all three writers run.
  await created("A");
  let page: Page = await nextPageAt(context, url);
  const emptyA = await firstReads(page);
  await startWriters(page, "A:1");
  await writing(run, "A:1");
  const savedA1 = await marksOf(serviceWorker, () => created("B"));

  page = await nextPageAt(context, url, page);
  const emptyB = await firstReads(page);
  await startWriters(page, "B:1");
  await writing(run, "B:1");

  /** Switches to `label`, checks what came back, and starts its writers again as `next`. */
  const switchTo = async (label: string, session: string, saved: typeof savedA1, next: string) => {
    const marks = await marksOf(serviceWorker, () =>
      command({ type: "workspace-switch", identityId: ids[label] }),
    );
    page = await nextPageAt(context, url, page);
    const first = await firstReads(page);
    const sent = await beacons(run);
    outcomes[session] = checkRestore({ first, identity: label, session }, sent, cutoffOf(saved));
    skew[session] = {
      page: first.databases.page?.max,
      mirror: first.databases.mirror?.max,
      mirrorGap: (first.databases.mirror?.max ?? 0) - (first.databases.mirror?.count ?? 0),
      localStorage: first.pageSeq,
    };
    await startWriters(page, next);
    await writing(run, next);
    return marks;
  };

  const savedB1 = await switchTo("A", "A:1", savedA1, "A:2");
  const savedA2 = await switchTo("B", "B:1", savedB1, "B:2");
  await switchTo("A", "A:2", savedA2, "A:3");

  expect(emptyA).toEqual({
    databases: { page: null, worker: null, sw: null, mirror: null },
    pageSeq: null,
  });
  // B starts empty though A's writers ran until its window closed.
  expect(emptyB).toEqual(emptyA);
  for (const session of ["A:1", "B:1", "A:2"]) {
    for (const writer of ["page", "worker", "sw"]) {
      expect(outcomes[session]?.[writer]?.restored, `${session} ${writer}`).toBeGreaterThan(0);
    }
  }

  const windows = (marks: typeof savedA1) => {
    const { capture, persist, close } = cutoffOf(marks);
    return { captureMs: persist - capture, commitToCloseMs: close - persist };
  };
  await keep("writers", {
    outcomes,
    skew,
    windows: { "A:1": windows(savedA1), "B:1": windows(savedB1), "A:2": windows(savedA2) },
  });
});
