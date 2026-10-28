// The /pwa/ routes: per run, the server's app version and an offline switch the spec flips.
import { bodyOf, cookiesOf, HTML, JS, JSON_TYPE, send } from "./http.ts";
import type { Exchange } from "./http.ts";
import { pwaHtml, pwaManifest, pwaServiceWorker } from "./pwa-pages.ts";

interface PwaServer {
  version: number;
  offline: boolean;
}

const states = new Map<string, PwaServer>();

const stateOf = (run: string | undefined): PwaServer => {
  const key = run ?? "";
  const state = states.get(key) ?? { version: 1, offline: false };
  states.set(key, state);
  return state;
};

type Handler = (exchange: Exchange) => void | Promise<void>;

/** Offline drops the connection without an answer, as an unreachable server looks to Chrome. */
const online =
  (handler: Handler): Handler =>
  (exchange) => {
    if (stateOf(exchange.run).offline) exchange.request.socket.destroy();
    else return handler(exchange);
  };

/** Signs in: the session cookie is HttpOnly, so only requests carry it, never page scripts. */
function login({ response, url }: Exchange): void {
  const user = url.searchParams.get("user") ?? "";
  const cookie = `pwa_user=${encodeURIComponent(user)}; Path=/pwa/; HttpOnly; SameSite=Lax`;
  send(response, JSON_TYPE, "{}", { "set-cookie": cookie });
}

/** The authenticated API: the signed-in user by the session cookie, and who asked. */
function me({ request, response, run }: Exchange): void {
  const user = cookiesOf(request).pwa_user;
  const from = String(request.headers["x-pwa-from"] ?? "page");
  const body = JSON.stringify({ user: user ?? null, version: stateOf(run).version, from });
  if (user === undefined) {
    response.writeHead(401, { "content-type": JSON_TYPE, "cache-control": "no-store" });
    response.end(body);
  } else send(response, JSON_TYPE, body);
}

/** The spec's switch: `{ version?, offline? }` for the run. */
async function control({ request, response, run }: Exchange): Promise<void> {
  Object.assign(stateOf(run), (await bodyOf(request)) as Partial<PwaServer>);
  send(response, JSON_TYPE, JSON.stringify(stateOf(run)));
}

export const pwaRoutes: Record<string, Handler> = {
  "GET /pwa/": online(({ response, run }) =>
    send(response, HTML, pwaHtml(run ?? "", stateOf(run).version)),
  ),
  "GET /pwa/manifest.json": online(({ response }) =>
    send(response, "application/manifest+json", pwaManifest),
  ),
  "GET /pwa/sw.js": online(({ response, run }) =>
    send(response, JS, pwaServiceWorker(stateOf(run).version)),
  ),
  "GET /pwa/login": online(login),
  "GET /pwa/api/me": online(me),
  "POST /pwa/control": control,
};
