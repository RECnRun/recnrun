import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";

export interface LedgerEntry {
  seq: number;
  ts: number;
  origin: string;
  path: string;
  method: string;
  user: string | null;
  cookieHash: string | null;
  secFetchDest: string | null;
  secFetchMode: string | null;
  secFetchSite: string | null;
  requestOrigin: string | null;
  marker: string | null;
  effect: string | null;
}

export interface Ledger {
  /** Records a request; control requests (the ledger's own endpoints) get an entry that is not kept. */
  record(req: IncomingMessage, url: URL, user: string | null): LedgerEntry;
  entries(): readonly LedgerEntry[];
  reset(): void;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  return typeof value === "string" ? value : null;
}

export function createLedger(): Ledger {
  // Sequence numbers keep growing across resets so entries never compare equal by order.
  let seq = 0;
  let list: LedgerEntry[] = [];
  return {
    record(req, url, user) {
      const cookie = header(req, "cookie");
      const entry: LedgerEntry = {
        seq: ++seq,
        ts: Date.now(),
        origin: url.origin,
        path: url.pathname + url.search,
        method: req.method ?? "GET",
        user,
        cookieHash: cookie === null ? null : sha256(cookie),
        secFetchDest: header(req, "sec-fetch-dest"),
        secFetchMode: header(req, "sec-fetch-mode"),
        secFetchSite: header(req, "sec-fetch-site"),
        requestOrigin: header(req, "origin"),
        marker: url.pathname === "/__marker" ? url.searchParams.get("name") : null,
        effect: null,
      };
      if (!url.pathname.startsWith("/__ledger")) list.push(entry);
      return entry;
    },
    entries: () => list,
    reset: () => {
      list = [];
    },
  };
}
