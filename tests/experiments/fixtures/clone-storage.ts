import type { Page } from "@playwright/test";
import { localOf, reopen } from "./clone-round.ts";
import type { Round, RoundClone } from "./clone-round.ts";
import { sampleOf } from "./clones.ts";
import type { Sample } from "../outcome.ts";

/*
 * CL08 (POC PLAN.md P5.5): what A and B write on one origin and in their extension storage stays in
 * its own copy of the base, survives A's close and reopen, and C, made later from the base, holds
 * none of it.
 */

export interface Marks {
  cookie: string | null;
  local: string | null;
  idb: string | null;
}

const MARKS = {
  A: { cookie: "cookie-from-a", local: "local-from-a", idb: "idb-from-a" },
  B: { cookie: "cookie-from-b", local: "local-from-b", idb: "idb-from-b" },
} as const;
const EXTENSION_MARKS = { A: "storage-from-a", B: "storage-from-b" } as const;
// Chrome commits a new cookie to disk after about 30 s; SIGTERM before then loses it (CHROMIUM.md).
const COOKIE_COMMIT_MS = 32_000;
const NONE: Marks = { cookie: null, local: null, idb: null };

/** Writes the three marks on the page's origin: a cookie that outlives the session, a key, a record. */
async function write(page: Page, marks: { cookie: string; local: string; idb: string }) {
  await page.evaluate(async (m) => {
    document.cookie = `recnrun_mark=${m.cookie}; max-age=86400; path=/`;
    localStorage.setItem("recnrun_mark", m.local);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("recnrun", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("marks");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("marks", "readwrite");
      tx.objectStore("marks").put(m.idb, "mark");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, marks);
}

/** The three marks as the page's origin shows them in this profile. */
async function readMarks(page: Page): Promise<Marks> {
  return page.evaluate(async () => {
    const cookie = /(?:^|; )recnrun_mark=([^;]*)/.exec(document.cookie)?.[1] ?? null;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("recnrun", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("marks");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const idb = await new Promise<string | null>((resolve, reject) => {
      const get = db.transaction("marks").objectStore("marks").get("mark");
      get.onsuccess = () => resolve((get.result as string | undefined) ?? null);
      get.onerror = () => reject(get.error);
    });
    db.close();
    return { cookie, local: localStorage.getItem("recnrun_mark"), idb };
  });
}

const extensionMark = async (clone: RoundClone) => {
  const value = await localOf(clone.profile, "cloneMarker");
  return typeof value === "string" ? value : null;
};

const setExtensionMark = (clone: RoundClone, value: string) =>
  clone.profile.serviceWorker.evaluate(
    (marker) =>
      (
        globalThis as unknown as {
          chrome: { storage: { local: { set(v: unknown): Promise<void> } } };
        }
      ).chrome.storage.local.set({ cloneMarker: marker }),
    value,
  );

/** What a clone holds now, in the page's origin and in its extension's local storage. */
async function holdings(clone: RoundClone) {
  return {
    origin: await readMarks(clone.view.site),
    extension: await extensionMark(clone),
  };
}

/** The differences between what `clone` holds and what it should (`NONE` and no marker for a clean clone). */
export async function differences(
  clone: RoundClone,
  expected: { origin: Marks; extension: string | null },
) {
  const held = await holdings(clone);
  const out: string[] = [];
  for (const key of ["cookie", "local", "idb"] as const) {
    if (held.origin[key] !== expected.origin[key])
      out.push(
        `${clone.name} ${key} was ${String(held.origin[key])}, expected ${String(expected.origin[key])}`,
      );
  }
  if (held.extension !== expected.extension)
    out.push(
      `${clone.name} extension storage was ${String(held.extension)}, expected ${String(expected.extension)}`,
    );
  return out;
}

/** The marks `name` writes, as the cell expects to read them back. */
const expectedOf = (name: "A" | "B") => ({
  origin: { ...MARKS[name] },
  extension: EXTENSION_MARKS[name],
});

/** A clean clone: nothing of A's or B's. */
export const CLEAN = { origin: NONE, extension: null };

const byName = (round: Round, name: "A" | "B") => {
  const clone = round.clones.find((each) => each.name === name);
  if (!clone) throw new Error(`The round has no clone ${name}.`);
  return clone;
};

/** CL08: A and B write, each reads only its own, A is closed and reopened, B still differs. */
export async function isolationCell(round: Round): Promise<Sample> {
  const [a, b] = [byName(round, "A"), byName(round, "B")];
  for (const clone of [a, b]) {
    await write(clone.view.site, MARKS[clone.name as "A" | "B"]);
    await setExtensionMark(clone, EXTENSION_MARKS[clone.name as "A" | "B"]);
  }
  const problems = [
    ...(await differences(a, expectedOf("A"))),
    ...(await differences(b, expectedOf("B"))),
  ];
  await new Promise((resolve) => setTimeout(resolve, COOKIE_COMMIT_MS));
  const reopened = await reopen(round, a);
  if (reopened.code !== 0) problems.push(`A did not reopen: ${reopened.stderr.trim().slice(-200)}`);
  else
    problems.push(
      ...(await differences(a, expectedOf("A"))),
      ...(await differences(b, expectedOf("B"))),
    );
  return sampleOf(problems, { reopenedMs: reopened.ms });
}
