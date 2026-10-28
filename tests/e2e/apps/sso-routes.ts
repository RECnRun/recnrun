// The /sso/ provider routes (served on sso.localhost) and the /sso-app/ client route.
import { cookiesOf, HTML, redirectTo, send } from "./http.ts";
import type { Exchange } from "./http.ts";
import { idpLoginHtml, idpStorageHtml, ssoAppHtml } from "./sso-pages.ts";

/** The provider's session: HttpOnly, so only a capture through `cookies.getAll` can see it. */
const session = (user: string) =>
  `idp_session=${encodeURIComponent(user)}; Path=/sso/; HttpOnly; SameSite=Lax`;

/** Signs `user` in at the provider and returns to `redirect_uri` with the user in the fragment. */
function login({ response, url }: Exchange): void {
  const user = url.searchParams.get("user") ?? "";
  const back = `${url.searchParams.get("redirect_uri") ?? ""}#user=${encodeURIComponent(user)}`;
  send(response, HTML, idpLoginHtml(user, back), { "set-cookie": session(user) });
}

/** Returns at once: the session's user, or `login_required` for a silent check without one. */
function authorize({ request, response, url }: Exchange): void {
  const user = cookiesOf(request).idp_session;
  const back = url.searchParams.get("redirect_uri") ?? "";
  if (user !== undefined) redirectTo(response, `${back}#user=${user}`);
  else if (url.searchParams.get("prompt") === "none")
    redirectTo(response, `${back}#error=login_required`);
  else send(response, HTML, "<!doctype html><title>Sign in</title><p>Sign in</p>");
}

export const ssoRoutes: Record<string, (exchange: Exchange) => void> = {
  "GET /sso/login": login,
  "GET /sso/authorize": authorize,
  "GET /sso/storage": ({ response }) => send(response, HTML, idpStorageHtml),
  "GET /sso-app/": ({ response, run }) => send(response, HTML, ssoAppHtml(run ?? "")),
};
