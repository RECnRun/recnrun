// A single-page app behind SSO, modelled on Zephyr: its root and deep link serve the app with its
// session and send anyone else to its provider: a 302 typed application/binary on `spa-binary.*`,
// a 302 typed text/html on `spa-html.*`, and a page that refreshes to it on `spa-meta.*`.
import { cookiesOf, HTML, send } from "./http.ts";
import type { Exchange } from "./http.ts";

/** The app's deep link, where its users work. */
export const SPA_PATH = "/spa/app/context";
const PROVIDER = "http://idp.localhost:5192/idp/login";

const spaHtml =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SPA</title></head>' +
  "<body><h1>SPA</h1></body></html>";

const providerHtml =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Provider</title></head>' +
  "<body><h1>Sign in</h1></body></html>";

/** A signed-out page that leaves for the provider at once, scripts or not. */
const refreshTo = (location: string) =>
  `<!doctype html><html lang="en"><head><meta http-equiv="refresh" content="0;url=${location}">` +
  "<title>Redirecting</title></head><body></body></html>";

/** The app with its session, or a redirect to its provider without one. */
export function spaPage({ request, response, host, url }: Exchange): void {
  if (cookiesOf(request).spa_session === "1") return send(response, HTML, spaHtml);
  const binary = host.startsWith("spa-binary.");
  const back = encodeURIComponent(`http://${host}${url.pathname}`);
  if (host.startsWith("spa-meta."))
    return send(response, HTML, refreshTo(`${PROVIDER}?return=${back}`));
  response.writeHead(302, {
    location: `${PROVIDER}?return=${back}`,
    "content-type": binary ? "application/binary" : HTML,
    "cache-control": "no-store",
  });
  response.end(binary ? "\u0000redirect" : "<p>Redirecting to sign in</p>");
}

/** The provider's callback: a session for the app, then its deep link. */
function signIn({ response }: Exchange): void {
  response.writeHead(302, {
    location: SPA_PATH,
    "set-cookie": "spa_session=1; Path=/; HttpOnly; SameSite=Lax",
    "cache-control": "no-store",
  });
  response.end();
}

export const spaRoutes: Record<string, (exchange: Exchange) => void> = {
  [`GET ${SPA_PATH}`]: spaPage,
  "GET /spa/signin": signIn,
  "GET /idp/login": ({ response }) => send(response, HTML, providerHtml),
};
