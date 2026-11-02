# Fixture

The application under test for the namespaced-sessions POC ([PLAN.md](../../docs/poc/namespace-sessions/PLAN.md), task P0.6). It is development-only, holds no RECnRun code, and does not cooperate with session selection: it knows nothing about namespaces, the reserved `__rec:` prefix, or the extension. It imports nothing from the workspace, and only test harnesses start it (`fixture-isolated` and `only-tests-start-the-fixture` in `.dependency-cruiser.cjs`).

```sh
vp run dev:fixture        # the four listeners on their default ports
vp run fixture#freeze     # rewrite freeze.json (only with the owner's agreement, see below)
```

Tests start it in-process with `startFixture({ ports })` from `src/server.ts`; port `0` picks a free port. One Node process serves four origins and keeps one in-memory ledger. There is no build: the files under `public/` are served as they are.

## Origins and routes

Chrome resolves `*.localhost` to the loopback without DNS. The public pages hardcode the default ports, so browser tests use the defaults.

| Origin                      | Route                                                    | What it does                                                                                                   |
| --------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `http://idp.localhost:4602` | `GET /login?redirect=`                                   | Login form; the username is the identity, there is no password                                                 |
|                             | `GET /login?mode=popup&origin=`                          | Popup variant: after login, `popup-done.html` posts `{ type: "fixture-login", user }` to the opener and closes |
|                             | `POST /login`                                            | Creates the IdP session (`idp_sid`), then `302` to the API's `/session` exchange                               |
|                             | `GET /renew.html?origin=`, `POST /renew`                 | Silent-renew iframe: rotates `idp_sid` and posts `{ type: "fixture-renew", ok, user }` to the parent           |
|                             | `GET /whoami`                                            | `{ user }` from `idp_sid`                                                                                      |
|                             | `GET /logout?redirect=`                                  | Ends the IdP session, then `302` to the API's `/logout`                                                        |
| `http://api.localhost:4601` | `GET /session?code=&redirect=`                           | Exchanges the one-time code for the API session (`api_sid`), then `302` to the app                             |
|                             | `GET /me`                                                | `{ user }`, or `401 { user: null }`                                                                            |
|                             | `GET /slow?ms=`                                          | Answers after at least `ms` milliseconds (at most 60 s)                                                        |
|                             | `GET /redirect/3`                                        | `302` chain `/redirect/2` → `/redirect/1` → `/me`                                                              |
|                             | `GET /private`                                           | `Cache-Control: private, max-age=60`, `Vary: Origin, Cookie`                                                   |
|                             | `POST /act?op=`                                          | Side effect: counts per user and operation; the ledger entry gets `effect: "act:<op>"`                         |
|                             | `GET /events`                                            | EventSource: `event: hello` with `{ user }`, then a keepalive comment every 15 s                               |
|                             | `GET /ws`                                                | WebSocket echo (hand-rolled RFC 6455, text and binary)                                                         |
|                             | `GET /logout?redirect=`                                  | Ends the API session, then `302` to the app                                                                    |
|                             | `GET /__ledger`, `POST /__ledger/reset`                  | The shared ledger as a JSON array; reset empties it                                                            |
|                             | `GET /__network`, `POST /__network?mode=offline\|online` | Reports or sets the network cut (see below)                                                                    |
|                             | `POST /__expire?user=`                                   | Server-side expiry: ends every `api_sid` and `idp_sid` session of the user; `{ user, expired }`                |
| `http://app.localhost:4600` | `/`                                                      | Signed-in user, login and logout links, popup login, silent renew, an `act` button                             |
|                             | `/storage.html`                                          | localStorage, sessionStorage, `document.cookie`, IndexedDB, Cache Storage, OPFS, Web Locks, BroadcastChannel   |
|                             | `/workers.html?type=classic\|module`                     | A dedicated worker (`worker.js`) and a shared worker (`shared-worker.js`) of that type                         |
|                             | `/sw.html?sw=classic\|module\|imports\|static\|dynamic`  | Registers the service worker variant at scope `/`, then tries Background Sync and a push subscription          |
|                             | `/sockets.html`                                          | WebSocket echo and EventSource against the API                                                                 |
|                             | `/offline.html`                                          | Offline shell, precached by the service worker                                                                 |
| `http://app.localhost:4603` | same as 4600                                             | Staging copy: the same files, the same IdP and API                                                             |
| every origin                | `GET /__marker?name=`                                    | `204`; the ledger entry gets `marker: name`                                                                    |

Service worker variants: `classic` and `module` register `sw-main.js` as that type; `imports` is a classic script that loads `sw-main.js` and `sw-imported.js` with `importScripts`; `static` is a module that imports `sw-main.js`; `dynamic` is `static` plus a dynamic `import()` whose outcome is a marker (Chrome rejects it in service workers with `TypeError`). `sw-main.js` precaches the shell on install, enables navigation preload on activate, answers navigations from the preload or the network and falls back to `offline.html`, serves precached files cache-first, and records `push` and `sync` events as markers.

### First statements and markers

Every worker (dedicated, shared, service) makes an authenticated request to `api.localhost:4601/me?from=<script URL>` (`credentials: "include"`), opens an IndexedDB database, and opens a cache as its first three statements. `worker.js`, `shared-worker.js`, and `sw-main.js` are valid both as classic scripts and as modules, so every type runs the same first statements.

Every page awaits `/__marker?name=<page>:start` before its first effect, and sends `<page>:first-paint` after it has rendered its results. Workers report only after their first request was answered, so on `workers.html` and `sw.html` the ledger orders the page's `start` marker, then the worker's `/me`, then the page's `first-paint` marker.

## Test controls

Routes under `/__` are the harness's controls; the network cut never affects them.

- **Network cut** (PLAN.md P6.1): after `POST /__network?mode=offline`, every request and WebSocket upgrade to the app, staging, and API origins, except `/__*`, is dropped: the server destroys the socket without a response, so the browser sees a network error, not an HTTP status, and the ledger entry gets `effect: "network:dropped"`. Going offline also closes the open connections of those origins (EventSource streams, WebSockets, keep-alive sockets), as a real network loss would. The IdP stays reachable. `POST /__network?mode=online` restores service.
- **Server-side expiry** (PLAN.md P6.6, T21): `POST /__expire?user=<name>` ends that user's API and IdP sessions and pending login codes. The next `/me` answers `401`, `/whoami` answers `{ user: null }`, silent renew fails, and the user has to log in again at the IdP.

## Ledger

Every request to any of the four listeners appends an entry, except the ledger's own endpoints:

| Field                                          | Value                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| `seq`                                          | Increasing across the process; a reset does not restart it            |
| `ts`                                           | `Date.now()` when the request arrived                                 |
| `origin`, `path`, `method`                     | The listener's origin, path with query, and HTTP method               |
| `user`                                         | From `api_sid` on the API, `idp_sid` on the IdP; `null` on the app    |
| `cookieHash`                                   | SHA-256 of the whole `Cookie` header, never its value; `null` if none |
| `secFetchDest`, `secFetchMode`, `secFetchSite` | The `Sec-Fetch-*` headers, or `null`                                  |
| `requestOrigin`                                | The `Origin` header, or `null`                                        |
| `marker`, `effect`                             | Set by `/__marker` and `/act`; otherwise `null`                       |

## Cookie flow

1. The app links to `idp.localhost:4602/login?redirect=<app URL>` (a top-level navigation).
2. The form posts to the IdP, which sets `idp_sid` and redirects to `api.localhost:4601/session?code=<one-time code>&redirect=<app URL>`.
3. The API redeems the code, sets `api_sid`, and redirects to the app. From then on the app's `fetch(..., { credentials: "include" })` and its workers reach the API as that user, and the IdP knows the user for popups and silent renew.

Both cookies are host-only, `HttpOnly; Secure; SameSite=None; Path=/`. `app.localhost`, `api.localhost`, and `idp.localhost` are different sites (`localhost` is the registrable suffix, so each subdomain is its own site), so a credentialed call from the app to the API and the silent-renew iframe are cross-site and need `SameSite=None`, which needs `Secure`. Redirect targets must be fixture origins; anything else is a `400`.

Observed on Google Chrome 156.0.8078.76 (macOS, headless, Playwright `channel: "chrome"`, fresh profile, 2026-11-02):

- Chrome accepts `Secure; SameSite=None` cookies set over `http://*.localhost` and sends them on the cross-site credentialed requests above; it treats these origins as potentially trustworthy (secure contexts), so Cache Storage, OPFS, and service workers work over plain HTTP.
- App → API requests carry `Sec-Fetch-Site: cross-site`; the app's own requests carry `same-origin`.
- Every route answered as described: login by redirect and by popup, silent renew, logout, all storage probes, classic and module dedicated and shared workers, all five service worker variants (Background Sync registered and fired; the push subscription was refused with `NotAllowedError: Registration failed - permission denied`), WebSocket echo, EventSource, and the offline shell (network cut with Playwright's `setOffline` for this check only; POC tests cut it at the fixture with `/__network`).
- Third-party cookies were allowed in that profile. A profile that blocks them would drop `api_sid` on the app's calls and `idp_sid` in the renew iframe; that is the browser's policy, not the fixture's.

## Freeze

`freeze.json` holds the SHA-256 of every file under `src/` and `public/`. The served assets are the files under `public/`; the server modules under `src/` are not assets, but they shape every response, so they are frozen with the files they serve. `scripts/` and `tests/` are not frozen. `tests/freeze.test.ts` fails when a file changes, appears, or disappears. Changing the fixture after P0.6 needs a new freeze, a line under P0.6 in [CHECKLIST.md](../../docs/poc/namespace-sessions/CHECKLIST.md) saying what changed and why, and the owner's agreement: the application under test must not learn to cooperate.
