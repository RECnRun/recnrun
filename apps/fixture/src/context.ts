import type { IncomingMessage, ServerResponse } from "node:http";
import { readCookie } from "./http.ts";
import type { Ledger, LedgerEntry } from "./ledger.ts";
import type { Sessions } from "./sessions.ts";

export type Role = "app" | "api" | "idp" | "staging";
export type Origins = Record<Role, string>;

/** The cookie each host reads its session from; the app hosts have none. */
export const SESSION_COOKIES = { api: "api_sid", idp: "idp_sid" } as const;

/** The fixture-side network cut: the server, not the browser harness, takes the app and API offline. */
export interface Network {
  offline: boolean;
  /** Closes the open connections of the cut origins, as a real network loss would. */
  closeOpen(): void;
}

export interface FixtureContext {
  origins: Origins;
  ledger: Ledger;
  sessions: Sessions;
  network: Network;
  publicDir: string;
}

/** One request as every handler sees it. */
export interface Call {
  ctx: FixtureContext;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  entry: LedgerEntry;
  user: string | null;
}

export type Handler = (call: Call) => void | Promise<void>;

export function isFixtureOrigin(ctx: FixtureContext, origin: string | null | undefined): boolean {
  return typeof origin === "string" && Object.values(ctx.origins).includes(origin);
}

/** While offline, the app, staging, and API origins drop everything but the control routes. */
export function isCut(ctx: FixtureContext, role: Role, url: URL): boolean {
  return ctx.network.offline && role !== "idp" && !url.pathname.startsWith("/__");
}

/** The redirect target when it points back into the fixture, otherwise null. */
export function allowedRedirect(ctx: FixtureContext, value: string | null): string | null {
  if (value === null || !URL.canParse(value)) return null;
  return isFixtureOrigin(ctx, new URL(value).origin) ? value : null;
}

/** Ends the session the cookie names and returns where the browser goes next. */
export function endSession({ ctx, req, url }: Call, cookie: string): string {
  ctx.sessions.destroy(readCookie(req, cookie));
  return allowedRedirect(ctx, url.searchParams.get("redirect")) ?? `${ctx.origins.app}/`;
}
