import type { Worker } from "@playwright/test";

/** How a test breaks an identity's published capture in the extension's IndexedDB. */
export type Tamper = "invalid" | "incomplete" | "missing" | "unpublished";

interface TamperGlobal {
  __untampered?: { pointer: unknown; header: unknown };
}

/**
 * Breaks `identityId`'s published capture as `how` says, keeping the original rows to put back:
 * a header that fails its schema, one still in progress, one gone, or no pointer to it at all.
 */
export const tamperCapture = (serviceWorker: Worker, identityId: string, how: Tamper) =>
  serviceWorker.evaluate(
    async ([id, kind]) => {
      const done = <T>(request: IDBRequest<T>) =>
        new Promise<T>((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error ?? new Error("request failed"));
        });
      const db = await done(indexedDB.open("recnrun-identity-captures"));
      const tx = db.transaction(["captures", "pointers"], "readwrite");
      const pointers = tx.objectStore("pointers");
      const captures = tx.objectStore("captures");
      const pointer = (await done(pointers.get(id))) as { captureId: string };
      const header = (await done(captures.get(pointer.captureId))) as { endedAt?: number };
      (globalThis as TamperGlobal).__untampered = { pointer, header };
      // An interrupted capture: still in progress, so it never ended.
      const { endedAt: _ended, ...started } = header;
      if (kind === "invalid") captures.put({ ...header, url: 42 });
      else if (kind === "incomplete") captures.put({ ...started, status: "in-progress" });
      else if (kind === "missing") captures.delete(pointer.captureId);
      else pointers.delete(id);
      await new Promise((resolve) => (tx.oncomplete = resolve));
      db.close();
    },
    [identityId, how] as const,
  );

/** Puts back the rows the last `tamperCapture` changed. */
export const untamperCapture = (serviceWorker: Worker) =>
  serviceWorker.evaluate(async () => {
    const kept = (globalThis as TamperGlobal).__untampered;
    if (!kept) throw new Error("Nothing was tampered with.");
    const opening = indexedDB.open("recnrun-identity-captures");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error ?? new Error("open failed"));
    });
    const tx = db.transaction(["captures", "pointers"], "readwrite");
    tx.objectStore("captures").put(kept.header);
    tx.objectStore("pointers").put(kept.pointer);
    await new Promise((resolve) => (tx.oncomplete = resolve));
    db.close();
  });

/** The identity's pointer row and how many captures it has stored, published or not. */
export const storedCaptures = (serviceWorker: Worker, identityId: string) =>
  serviceWorker.evaluate(async (id) => {
    const opening = indexedDB.open("recnrun-identity-captures");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error ?? new Error("open failed"));
    });
    const tx = db.transaction(["captures", "pointers"], "readonly");
    const pointer = tx.objectStore("pointers").get(id);
    const count = tx.objectStore("captures").index("byIdentity").count(id);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error ?? new Error("read failed"));
    });
    db.close();
    return { pointer: pointer.result as unknown, count: count.result };
  }, identityId);
