// The lab's fixture: an app and a cross-site identity provider with fictional users. Its request log
// records the Cookie header of every request: the ground truth for every network result. It is
// test infrastructure, not a product backend.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { workflowRoutes } from "./fixture-workflow.mjs";

export const APP_PORT = 4318;
export const IDP_PORT = 4319;
// *.localhost resolves to loopback and is a secure context; no RECnRun build matches it.
export const APP = `http://app.localhost:${APP_PORT}`;
export const IDP = `http://idp.localhost:${IDP_PORT}`;

// The app's pages read the identity provider's /whoami from their own origin.
const CORS = { "access-control-allow-origin": APP, "access-control-allow-credentials": "true" };
const SESSION = "sid=%s; Path=/; HttpOnly; SameSite=Lax";
const page = (name) => readFileSync(fileURLToPath(new URL(`fixture/${name}`, import.meta.url)));

function readBody(request) {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => resolve(body));
  });
}

function cookiesOf(request) {
  const pairs = (request.headers.cookie ?? "").split(";").map((pair) => pair.trim().split("="));
  return Object.fromEntries(
    pairs.filter(([name]) => name).map(([name, ...v]) => [name, v.join("=")]),
  );
}

function send(response, status, headers, body = "") {
  response.writeHead(status, { "cache-control": "no-store", ...headers }).end(body);
}

const json = (response, value, headers = {}) =>
  send(response, 200, { "content-type": "application/json", ...headers }, JSON.stringify(value));

const TYPES = { html: "text/html", js: "text/javascript" };

function serveFile(response, name) {
  const type = TYPES[name.split(".").at(-1)] ?? "text/plain";
  try {
    send(response, 200, { "content-type": type }, page(name));
  } catch {
    send(response, 404, {});
  }
}

function appRoutes(state) {
  const userOf = (request) => state.sessions.get(cookiesOf(request).sid) ?? null;
  const signIn = (user) => {
    const sid = randomUUID();
    state.sessions.set(sid, user);
    return SESSION.replace("%s", sid);
  };
  return {
    "POST /login": async (request, response) => {
      const user = new URLSearchParams(await readBody(request)).get("user");
      send(response, 302, { location: "/home", "set-cookie": signIn(user) });
    },
    "GET /me": (request, response) => json(response, { user: userOf(request) }),
    // Rendered by the server, so the document request itself must carry the new session.
    "GET /home": (request, response) => {
      const user = userOf(request) ?? "signed out";
      send(
        response,
        200,
        { "content-type": "text/html" },
        `<title>${user}</title><p id="user">${user}</p>`,
      );
    },
    "GET /poll": (request, response) => json(response, { user: userOf(request) }),
    "GET /me-cached": (request, response) =>
      json(response, { user: userOf(request) }, { "cache-control": "private, max-age=600" }),
    "GET /set-pref": (request, response, url) =>
      send(response, 204, { "set-cookie": `theme=${url.searchParams.get("theme")}; Path=/` }),
    "GET /logout": (request, response) =>
      send(response, 302, { location: "/home", "set-cookie": "sid=; Path=/; Max-Age=0" }),
    // The identity provider's code is the user name: the lab checks cookies, not OAuth.
    "GET /callback": (request, response, url) => {
      const target = url.searchParams.get("popup") ? "/popup-done" : "/home";
      send(response, 302, { location: target, "set-cookie": signIn(url.searchParams.get("code")) });
    },
    ...workflowRoutes(userOf, readBody, json),
  };
}

function idpRoutes() {
  return {
    "GET /authorize": (request, response, url) => {
      const user = cookiesOf(request).idp_user ?? url.searchParams.get("user");
      const popup = url.searchParams.get("popup") ? "&popup=1" : "";
      const location = `${APP}/callback?code=${encodeURIComponent(user)}${popup}`;
      // idp_embed is the one an embedded (cross-site) frame may receive.
      const cookies = [
        `idp_user=${user}; Path=/; HttpOnly; SameSite=Lax`,
        `idp_embed=${user}; Path=/; SameSite=None; Secure`,
      ];
      send(response, 302, { location, "set-cookie": cookies });
    },
    "GET /whoami": (request, response) => {
      const cookies = cookiesOf(request);
      json(response, { user: cookies.idp_user ?? cookies.idp_embed ?? null }, CORS);
    },
  };
}

function logRequest(state, request, port) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  state.log.push({
    at: Date.now(),
    port,
    method: request.method,
    path: url.pathname,
    tag: url.searchParams.get("tag"),
    cookie: request.headers.cookie ?? "",
    site: request.headers["sec-fetch-site"] ?? "",
  });
  return url;
}

function labRoutes(state) {
  return {
    "GET /__log": (request, response) => json(response, state.log),
    "POST /__reset": (request, response) => {
      state.log.length = 0;
      send(response, 204, {});
    },
  };
}

function handler(state, routes, port) {
  const serve = async (request, response) => {
    const url = logRequest(state, request, port);
    const route = routes[`${request.method} ${url.pathname}`];
    if (route) return route(request, response, url);
    const path = url.pathname === "/" ? "index" : url.pathname.slice(1);
    const file = path.includes(".") ? path : `${path}.html`;
    serveFile(response, port === IDP_PORT ? `idp-${file}` : file);
  };
  return (request, response) => void serve(request, response);
}

/** A WebSocket that sends the identity its handshake carried, then closes. */
function answerUpgrade(state, request, socket) {
  socket.on("error", () => {});
  logRequest(state, request, APP_PORT);
  const accept = createHash("sha1")
    .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const text = Buffer.from(
    JSON.stringify({ user: state.sessions.get(cookiesOf(request).sid) ?? null }),
  );
  socket.end(Buffer.concat([Buffer.from([0x81, text.length]), text]));
}

/** Starts both origins; returns `close()` and the state for in-process checks. */
export async function startFixture() {
  const state = { log: [], sessions: new Map() };
  const app = createServer(handler(state, { ...appRoutes(state), ...labRoutes(state) }, APP_PORT));
  app.on("upgrade", (request, socket) => answerUpgrade(state, request, socket));
  const idp = createServer(handler(state, idpRoutes(), IDP_PORT));
  const listen = (server, port) =>
    new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  await Promise.all([listen(app, APP_PORT), listen(idp, IDP_PORT)]);
  const stop = (server) => new Promise((resolve) => server.close(resolve));
  const close = async () => {
    app.closeAllConnections();
    idp.closeAllConnections();
    await Promise.all([stop(app), stop(idp)]);
  };
  return { state, close };
}
