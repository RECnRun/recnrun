// The fixture app of the origin snapshot lab: an app page whose first script only observes
// storage, an app script that writes what the spec asks, workers, and a service worker.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const PORT = Number(process.env.ORIGIN_LAB_PORT ?? 4330);
export const APP = `http://app.localhost:${PORT}`;
// Experiment D: a sign-in server on another host, with its session in an HttpOnly cookie.
export const SSO = `http://sso.localhost:${PORT}`;
const REALM = "/realms/lab/";

const asset = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
const TYPES = { html: "text/html", js: "text/javascript", json: "application/json" };

function send(response, type, body, headers = {}) {
  response.writeHead(200, { "content-type": TYPES[type], "cache-control": "no-store", ...headers });
  response.end(body);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const userOf = (request) => /(?:^|;\s*)sso_session=(\w+)/.exec(request.headers.cookie ?? "")?.[1];

/** Back to the app with the user in the fragment, as an OIDC implicit redirect would. */
function signedIn(response, url, user, headers = {}) {
  const back = url.searchParams.get("return") ?? "";
  if (!back.startsWith(`${APP}/`)) {
    response.writeHead(400);
    response.end("bad return");
    return;
  }
  response.writeHead(302, { location: `${back}#token=${user}`, ...headers });
  response.end();
}

/** `authorize` signs in silently from the session cookie; without one it shows the login page. */
function ssoRoutes() {
  return {
    [`${REALM}authorize`]: (request, response, url) => {
      const user = userOf(request);
      if (user) signedIn(response, url, user);
      else send(response, "html", "<!doctype html><title>SSO login</title><h1>SSO login</h1>");
    },
    [`${REALM}login`]: (_, response, url) => {
      const user = url.searchParams.get("user") ?? "";
      if (!/^\w+$/.test(user)) {
        response.writeHead(400);
        response.end("bad user");
        return;
      }
      const cookie = `sso_session=${user}; Path=${REALM}; HttpOnly; SameSite=Lax`;
      signedIn(response, url, user, { "set-cookie": cookie });
    },
  };
}

function routes(state) {
  return {
    "/observe": async (request, response) => {
      state.observations.push({ ...JSON.parse(await readBody(request)), at: Date.now() });
      send(response, "json", "{}");
    },
    "/observations": (_, response) => send(response, "json", JSON.stringify(state.observations)),
    "/reset": (_, response) => {
      state.observations.length = 0;
      state.requests.length = 0;
      send(response, "json", "{}");
    },
    "/requests": (_, response) => send(response, "json", JSON.stringify(state.requests)),
    "/app.js": (_, response) => send(response, "js", asset("app.js")),
    "/sso-app": (_, response) =>
      send(response, "html", asset("sso-app.html").replace("%SSO%", `${SSO}${REALM}authorize`)),
    "/worker.js": (_, response) => send(response, "js", asset("worker.js")),
    "/shared-worker.js": (_, response) => send(response, "js", asset("worker.js")),
    "/sw.js": (_, response) =>
      send(response, "js", asset("sw.js"), { "service-worker-allowed": "/" }),
  };
}

function handler(state) {
  const app = routes(state);
  const sso = ssoRoutes();
  return (request, response) => {
    const onSso = request.headers.host?.startsWith("sso.") === true;
    const table = onSso ? sso : app;
    const url = new URL(request.url ?? "/", onSso ? SSO : APP);
    state.requests.push({
      path: url.pathname,
      search: url.search,
      mode: request.headers["sec-fetch-mode"],
    });
    const route = table[url.pathname];
    if (route) {
      Promise.resolve(route(request, response, url)).catch((error) => {
        response.writeHead(500);
        response.end(String(error));
      });
      return;
    }
    // Every other path is the SPA shell, as most single-page app servers answer. no-store would
    // keep the page out of the back/forward cache.
    send(response, "html", asset("app.html"), { "cache-control": "no-cache" });
  };
}

/** Starts the fixture; `close()` stops it. `state` holds what the pages reported. */
export async function startFixture() {
  const state = { observations: [], requests: [] };
  const server = createServer(handler(state));
  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  const close = () => new Promise((resolve) => server.close(resolve));
  return { state, close };
}
