import type { IncomingMessage, ServerResponse } from "node:http";
import { redirect, send, sendJson } from "./http.ts";

const COOKIE = "fixture-signed-in";
const ACCOUNT_PATH = "/routes/session";
const LOGIN_PATH = `${ACCOUNT_PATH}?login`;

/** Whether the request carries the session cookie that `/api/session?login` sets. */
function signedIn(request: IncomingMessage): boolean {
  const cookies = request.headers.cookie ?? "";
  return cookies.split(";").some((entry) => entry.trim() === `${COOKIE}=yes`);
}

function landOnAccount(response: ServerResponse, cookie: string): void {
  send(response, 303, "", { Location: ACCOUNT_PATH, "Set-Cookie": cookie });
}

/** `?login` starts a session and `?expire` ends it, both landing on the account page; else says whether one holds. */
export function handleSession(response: ServerResponse, url: URL): void {
  if (url.searchParams.has("login")) {
    landOnAccount(response, `${COOKIE}=yes; Path=/; HttpOnly; SameSite=Lax`);
  } else if (url.searchParams.has("expire")) {
    landOnAccount(response, `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
  } else {
    sendJson(response, 200, { signedIn: signedIn(response.req) });
  }
}

/** Answers the account page without a session with the login page, as an expired session would; false otherwise. */
export function redirectExpired(request: IncomingMessage, response: ServerResponse, url: URL) {
  const gated = url.pathname === ACCOUNT_PATH && !url.searchParams.has("login");
  if (!gated || signedIn(request)) return false;
  redirect(response, 302, LOGIN_PATH);
  return true;
}
