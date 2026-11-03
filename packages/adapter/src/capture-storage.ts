import {
  MAX_STORAGE_ITEMS,
  STORAGE_AREAS,
  type SnapshotReason,
  type StorageArea,
} from "@recnrun/protocol";
import * as v from "valibot";
import { CookieJar, type StorageSession } from "./capture-cookies.ts";
import { Cut } from "./capture-cut.ts";

const StorageIdSchema = v.object({
  securityOrigin: v.optional(v.string()),
  storageKey: v.optional(v.string()),
  isLocalStorage: v.boolean(),
});

const changeOf = <E extends v.ObjectEntries>(type: string, entries: E) => ({
  type,
  schema: v.object({ storageId: StorageIdSchema, ...entries }),
});

const CHANGES: Record<string, ReturnType<typeof changeOf>> = {
  "DOMStorage.domStorageItemAdded": changeOf("item-added", {
    key: v.string(),
    newValue: v.string(),
  }),
  "DOMStorage.domStorageItemUpdated": changeOf("item-updated", {
    key: v.string(),
    oldValue: v.string(),
    newValue: v.string(),
  }),
  "DOMStorage.domStorageItemRemoved": changeOf("item-removed", { key: v.string() }),
  "DOMStorage.domStorageItemsCleared": changeOf("items-cleared", {}),
};

const NavigatedSchema = v.object({
  frame: v.object({ id: v.string(), url: v.string(), parentId: v.optional(v.string()) }),
});

const ExtraInfoSchema = v.object({ headers: v.record(v.string(), v.unknown()) });

const StorageKeySchema = v.object({ storageKey: v.pipe(v.string(), v.nonEmpty()) });

const ItemsSchema = v.object({ entries: v.array(v.tuple([v.string(), v.string()])) });

// Opaque and local documents (about:blank, data:, file:) have no storage worth a snapshot.
const isWeb = (url: string) => /^https?:/i.test(url);

const areaOf = (isLocalStorage: boolean): StorageArea => (isLocalStorage ? "local" : "session");

/** Web Storage and, for a page, cookies of one document session: changes and snapshots. */
export class StorageCapture {
  private readonly session: StorageSession;
  private readonly targetId: string;
  private readonly cookies: CookieJar | undefined;
  private closed = false;

  constructor(session: StorageSession, targetId: string, cookiePollMs: number | undefined) {
    this.session = session;
    this.targetId = targetId;
    // Chrome answers `Network.getCookies` for the page and all its frames, so only pages read it.
    this.cookies =
      cookiePollMs === undefined ? undefined : new CookieJar(session, targetId, cookiePollMs);
  }

  /** A target that was already running reads what it holds now. */
  started(url: string): void {
    if (!isWeb(url)) return;
    this.snapshot(this.targetId, "attach");
    this.cookies?.read("attach");
  }

  handle(method: string, params: unknown): void {
    const change = CHANGES[method];
    if (change) this.change(change, params);
    else if (method === "Page.frameNavigated") this.navigated(params);
    else if (method === "Network.responseReceivedExtraInfo") this.responded(params);
  }

  close(): void {
    this.closed = true;
    this.cookies?.close();
  }

  private change({ type, schema }: ReturnType<typeof changeOf>, params: unknown): void {
    const parsed = v.safeParse(schema, params);
    if (!parsed.success) return;
    const { storageId, ...fields } = parsed.output as {
      storageId: v.InferOutput<typeof StorageIdSchema>;
    } & Record<string, string>;
    const cut = new Cut();
    const clipped = Object.fromEntries(
      Object.entries(fields).map(([name, value]) => [name, cut.text(value)]),
    );
    const payload = {
      observation: "observed-change",
      area: areaOf(storageId.isLocalStorage),
      storageKey: storageId.storageKey ?? storageId.securityOrigin ?? "",
      ...clipped,
      ...cut.flag(),
    };
    this.session.emit({ category: "storage", type, component: "browser", payload }, null);
  }

  private navigated(params: unknown): void {
    const parsed = v.safeParse(NavigatedSchema, params);
    if (!parsed.success || !isWeb(parsed.output.frame.url)) return;
    const { id, parentId } = parsed.output.frame;
    this.snapshot(id, "navigation");
    if (parentId === undefined) this.cookies?.read("navigation");
  }

  private responded(params: unknown): void {
    const parsed = v.safeParse(ExtraInfoSchema, params);
    if (!parsed.success) return;
    const names = Object.keys(parsed.output.headers);
    if (names.some((name) => name.toLowerCase() === "set-cookie")) this.cookies?.read();
  }

  private snapshot(frameId: string, reason: SnapshotReason): void {
    this.session.track(this.read(frameId, reason).catch(() => undefined));
  }

  private async read(frameId: string, reason: SnapshotReason): Promise<void> {
    const key = v.safeParse(
      StorageKeySchema,
      await this.session.send("Storage.getStorageKey", { frameId }),
    );
    if (!key.success) return;
    const { storageKey } = key.output;
    for (const area of STORAGE_AREAS) {
      const storageId = { storageKey, isLocalStorage: area === "local" };
      const reply = await this.session.send("DOMStorage.getDOMStorageItems", { storageId });
      const parsed = v.safeParse(ItemsSchema, reply);
      if (!parsed.success || this.closed) continue;
      const cut = new Cut();
      const items = cut
        .list(parsed.output.entries, MAX_STORAGE_ITEMS)
        .map(([name, value]) => ({ key: cut.text(name), value: cut.text(value) }));
      const payload = { observation: "snapshot", reason, area, storageKey, items, ...cut.flag() };
      this.session.emit(
        { category: "storage", type: "snapshot", component: "browser", payload },
        frameId,
      );
    }
  }
}
