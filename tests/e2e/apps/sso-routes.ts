// The /sso/ provider routes (served on sso.localhost) and the /sso-app/ client routes: a browser
// client by default, a server-side session client with `server=1`.
import { randomUUID } from "node:crypto";
import { cookiesOf, HTML, JSON_TYPE, redirectTo, send } from "./http.ts";
import type { Exchange } from "./http.ts";
import {
  IDP,
  idpLoginHtml,
  idpSignInHtml,
  idpStorageHtml,
  ssoAppHtml,
  ssoServerHtml,
} from "./sso-pages.ts";

const APP = "http://app.localhost:5192";

/** The provider's session: HttpOnly, so only a capture through `cookies.getAll` can see it. */
const session = (user: string) =>
  `idp_session=${encodeURIComponent(user)}; Path=/sso/; HttpOnly; SameSite=Lax`;

/** `redirect_uri` with the answer in its fragment, or in its query for `response_mode=query`. */
function answerTo(url: URL, answer: Record<string, string>): string {
  const back = url.searchParams.get("redirect_uri") ?? "";
  const params = new URLSearchParams(answer).toString();
  if (url.searchParams.get("response_mode") !== "query") return `${back}#${params}`;
  return `${back}${back.includes("?") ? "&" : "?"}${params}`;
}

/** Runs whose provider sessions expired: their session cookies no longer sign anyone in. */
const expiredAtProvider = new Set<string>();

/** Signs `user` in at the provider and returns to `redirect_uri` with the user. */
function login({ response, url, run = "" }: Exchange): void {
  expiredAtProvider.delete(run);
  const user = url.searchParams.get("user") ?? "";
  const back = answerTo(url, { user });
  send(response, HTML, idpLoginHtml(user, back), { "set-cookie": session(user) });
}

/**
 * Returns at once with the session's user, or `login_required` for a silent check without one;
 * an interactive request without a session gets the sign-in page.
 */
function authorize({ request, response, url, run = "" }: Exchange): void {
  const user = expiredAtProvider.has(run) ? undefined : cookiesOf(request).idp_session;
  if (user !== undefined) redirectTo(response, answerTo(url, { user }));
  else if (url.searchParams.get("prompt") === "none")
    redirectTo(response, answerTo(url, { error: "login_required" }));
  else send(response, HTML, idpSignInHtml(url));
}

/** The server client's sessions by id, per run, so a spec can expire them. */
const sessions = new Map<string, { user: string; run: string }>();

/** The server client's page; an interactive client stays interactive through its callback. */
const serverPage = (run: string, url: URL) =>
  `/sso-app/?run=${encodeURIComponent(run)}&server=1` +
  (url.searchParams.get("interactive") === "1" ? "&interactive=1" : "");

/**
 * The server client: its session's page, or without one a silent check at the provider, or its
 * sign-in page with `interactive=1`.
 */
function serverApp({ request, response, url, run = "" }: Exchange): void {
  const id = cookiesOf(request).app_session;
  const user = id === undefined ? undefined : sessions.get(id)?.user;
  const error = url.searchParams.get("error");
  if (user !== undefined || error !== null) {
    send(response, HTML, ssoServerHtml(run, user ?? null, error));
    return;
  }
  const interactive = url.searchParams.get("interactive") === "1";
  const back = `${APP}/sso-app/callback?run=${encodeURIComponent(run)}${interactive ? "&interactive=1" : ""}`;
  const query = new URLSearchParams({ run, response_mode: "query", redirect_uri: back });
  if (!interactive) query.set("prompt", "none");
  redirectTo(response, `${IDP}/sso/authorize?${query.toString()}`);
}

/** Back from the provider: a new session for its user, or the page with its error. */
function callback({ response, url, run = "" }: Exchange): void {
  const user = url.searchParams.get("user");
  if (user === null) {
    const error = encodeURIComponent(url.searchParams.get("error") ?? "unknown");
    redirectTo(response, `${serverPage(run, url)}&error=${error}`);
    return;
  }
  const id = randomUUID();
  sessions.set(id, { user, run });
  const cookie = `app_session=${id}; Path=/sso-app/; HttpOnly; SameSite=Lax`;
  response.writeHead(302, { location: serverPage(run, url), "set-cookie": cookie });
  response.end();
}

/** Expires every server session of the run, as a session timeout does while nobody looks. */
function expire({ response, run }: Exchange): void {
  for (const [id, each] of sessions) if (each.run === run) sessions.delete(id);
  send(response, JSON_TYPE, "{}");
}

/** Expires the run's provider sessions, until someone signs in there again. */
function expireAtProvider({ response, run = "" }: Exchange): void {
  expiredAtProvider.add(run);
  send(response, JSON_TYPE, "{}");
}

export const ssoRoutes: Record<string, (exchange: Exchange) => void> = {
  "GET /sso/login": login,
  "GET /sso/authorize": authorize,
  "POST /sso/expire": expireAtProvider,
  "GET /sso/storage": ({ response }) => send(response, HTML, idpStorageHtml),
  "GET /sso-app/": (exchange) => {
    const { response, url, run } = exchange;
    if (url.searchParams.get("server") === "1") serverApp(exchange);
    else send(response, HTML, ssoAppHtml(run ?? ""));
  },
  "GET /sso-app/callback": callback,
  "POST /sso-app/expire": expire,
};
