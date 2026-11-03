import { MAX_STORAGE_ITEMS, type Cookie, type SnapshotReason } from "@recnrun/protocol";
import * as v from "valibot";
import { Cut } from "./capture-cut.ts";
import type { Draft } from "./capture-envelope.ts";

/** What storage capture needs from its CDP session. */
export interface StorageSession {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  emit: (draft: Draft, frameId: string | null) => void;
  track: (work: Promise<void>) => void;
}

const ChromeCookieSchema = v.object({
  name: v.string(),
  value: v.string(),
  domain: v.string(),
  path: v.string(),
  expires: v.number(),
  httpOnly: v.boolean(),
  secure: v.boolean(),
  session: v.boolean(),
  sameSite: v.optional(v.string()),
  partitionKey: v.optional(v.unknown()),
});

const CookiesSchema = v.object({ cookies: v.array(ChromeCookieSchema) });

type ChromeCookie = v.InferOutput<typeof ChromeCookieSchema>;

const SAME_SITE = ["Strict", "Lax", "None"] as const;
const sameSiteOf = (value: string | undefined) => SAME_SITE.find((each) => each === value);

const identity = ({ name, domain, path, partitionKey }: ChromeCookie) =>
  JSON.stringify([name, domain, path, partitionKey ?? null]);

const sameCookie = (a: ChromeCookie, b: ChromeCookie) =>
  a.value === b.value &&
  a.expires === b.expires &&
  a.httpOnly === b.httpOnly &&
  a.secure === b.secure &&
  a.sameSite === b.sameSite;

/** A cookie as the journal keeps it: an HttpOnly or Secure cookie never carries its value. */
function cookieOf(raw: ChromeCookie): Cookie {
  const cut = new Cut();
  const sameSite = sameSiteOf(raw.sameSite);
  return {
    name: cut.text(raw.name),
    domain: cut.text(raw.domain),
    path: cut.text(raw.path),
    ...(raw.httpOnly || raw.secure ? { redacted: true } : { value: cut.text(raw.value) }),
    httpOnly: raw.httpOnly,
    secure: raw.secure,
    session: raw.session,
    ...(!raw.session && { expires: raw.expires }),
    ...(sameSite && { sameSite }),
    ...cut.flag(),
  };
}

type Request = SnapshotReason | "changes";

/**
 * The page's cookie jar, read through `Network.getCookies`: Chrome 156 has no CDP event for a
 * cookie change, so the jar is read on a timer and after a response that sets cookies, and two
 * reads are compared. Reads never overlap; a request during a read runs once it ends.
 */
export class CookieJar {
  private readonly session: StorageSession;
  private readonly frameId: string;
  private readonly timer: ReturnType<typeof setInterval> | undefined;
  private known = new Map<string, ChromeCookie>();
  private reading = false;
  private next: Request | undefined;
  private quiet = false;
  private closed = false;

  constructor(session: StorageSession, frameId: string, pollMs: number) {
    this.session = session;
    this.frameId = frameId;
    if (pollMs > 0) {
      this.timer = setInterval(() => this.read(), pollMs);
      // The poll alone never keeps the process alive.
      this.timer.unref?.();
    }
  }

  /** Reads the jar: a snapshot with its reason, or changes since the last read. */
  read(request: Request = "changes"): void {
    if (this.closed || this.quiet) return;
    if (this.reading) {
      // A pending snapshot wins over a pending comparison, since it reports everything.
      if (this.next === undefined || this.next === "changes") this.next = request;
      return;
    }
    this.reading = true;
    this.session.track(this.load(request));
  }

  /** Ends the poll and starts no further read, so a drain waits only for the read under way. */
  quiesce(): void {
    this.quiet = true;
    clearInterval(this.timer);
  }

  close(): void {
    this.closed = true;
    this.quiesce();
  }

  private async load(request: Request): Promise<void> {
    try {
      const parsed = v.safeParse(CookiesSchema, await this.session.send("Network.getCookies"));
      if (parsed.success && !this.closed) this.settle(request, parsed.output.cookies);
    } catch {
      // A session that went away answers nothing; the next read or the detach settles it.
    } finally {
      this.reading = false;
      const next = this.next;
      this.next = undefined;
      if (next) this.read(next);
    }
  }

  private settle(request: Request, cookies: ChromeCookie[]): void {
    const current = new Map(cookies.map((cookie) => [identity(cookie), cookie]));
    if (request === "changes") this.compare(current);
    else this.snapshot(request, cookies);
    this.known = current;
  }

  private snapshot(reason: SnapshotReason, cookies: ChromeCookie[]): void {
    const cut = new Cut();
    const kept = cut.list(cookies, MAX_STORAGE_ITEMS).map(cookieOf);
    const payload = { observation: "snapshot", reason, cookies: kept, ...cut.flag() };
    this.emit("cookies-snapshot", payload);
  }

  private compare(current: Map<string, ChromeCookie>): void {
    for (const [id, cookie] of current) {
      const before = this.known.get(id);
      if (!before) this.change("cookie-added", cookie);
      else if (!sameCookie(before, cookie)) this.change("cookie-changed", cookie);
    }
    for (const [id, cookie] of this.known)
      if (!current.has(id)) this.change("cookie-removed", cookie);
  }

  private change(type: string, cookie: ChromeCookie): void {
    this.emit(type, { observation: "observed-change", cookie: cookieOf(cookie) });
  }

  private emit(type: string, payload: Record<string, unknown>): void {
    this.session.emit({ category: "storage", type, component: "browser", payload }, this.frameId);
  }
}
