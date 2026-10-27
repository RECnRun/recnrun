# RECnRun — POC: Origin snapshots, results

Status: **Phase 2 decision gate reached; Phase 3 waits for the user's go-ahead.** Plan: [poc-origin-snapshot-plan.md](poc-origin-snapshot-plan.md).

Intermediate decision: **Proceed with restrictions** (see [Phase 2](#phase-2-intermediate-decision)). No verdict (GO, CONDITIONAL GO, NO-GO) yet; that needs Phases 3 and 4.

## Environment

| Where  | Browser                                                                                                         | Runner                                                                                                           |
| ------ | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Host   | Chrome for Testing 156.0.8078.4 (Playwright 1.64.1 `chromium`), macOS, headless                                 | `vp run test:origin-snapshot-lab:local`                                                                          |
| Docker | Chromium 156.0.8078.4 (Playwright 1.64.1), Linux (image `mcr.microsoft.com/playwright:v1.64.1-noble`), headless | `vp run test:origin-snapshot-lab` (through `scripts/test-container.mjs`; evidence in `.artifacts/docker/<run>/`) |

The lab sets `LAB_HEADLESS=1` in its test task; without it a headed window opens for debugging. The evidence JSON of each experiment lands in `.artifacts/origin-snapshot-lab/` (ignored by Git).

## Phase 0: Reconnaissance

- **Structured clone messaging.** The manifest key `"message_serialization": "structured_clone"` (Chrome 148+) makes `runtime.sendMessage` and `runtime.connect` carry structured-cloneable values (`Date`, `Map`, `Blob`, `File`, `ArrayBuffer` copied, not transferred). Chrome's documentation states no size limit. `tabs.sendMessage` is not mentioned, so the lab only sends from the content script to the background.
- **WXT 0.21.4** supports content scripts with `registration: "runtime"` (no manifest entry; the background registers them). It has no typed option for `message_serialization`; Phase 3 adds the key through the manifest hook and checks that it reaches the built manifest.
- **Permissions the lab needs**: `scripting` (runtime content script, `location.replace` injection), `tabs`, `webNavigation` (commit of each navigation), `storage`/`unlimitedStorage` (extension IndexedDB), `offscreen` (A3 only), and `declarativeNetRequestWithHostAccess` (A2 only), with host access limited to the fixture's origin. A2 and A3 were rejected (below), so Phase 3 needs neither `offscreen` nor `declarativeNetRequestWithHostAccess`.
- **Back/forward cache.** Playwright launches Chromium with `--disable-back-forward-cache`; the lab removes that flag where history matters, so those runs use Chrome's default.
- **Zephyr (public facts only).** An Angular app under `/zephyr-domes-frontend/` served by Apache, with `ngsw.json` (asset groups `app` with 265 URLs and `assets` with 570, both prefetch; no data groups; `navigationUrls` exclude a last segment with a dot or `__`). No CSP or `Set-Cookie` on a `HEAD` of the entry page. Signed out, the app redirects to Keycloak on another host (`login-acc.one.be`, realm `ONE`, OpenID Connect), which sets its own cookies there. An origin snapshot of `zephyr-tq.one.be` does not include them, so the sign-in host's single sign-on session is shared by every identity: the manual run below measures what that does. **The inventory after sign-in is not done**: it needs the user to sign in by hand with a test account.

## Phase 1: Lab

`scripts/origin-snapshot-lab/` holds an unpacked lab extension (`extension/`), the fixture app (`fixture/`), the harness (`lab.mjs`), and the specs (`specs/*.checks.mjs`). Run it with `vp run test:origin-snapshot-lab` (Docker) or `vp run test:origin-snapshot-lab:local` (host). `ORIGIN_LAB_RUNS` (default 50) sets the runs per Experiment A cell and `ORIGIN_LAB_RECORDS` (default 10,000) the size of the large capture.

The fixture's first script is an observer that reads `localStorage`, `sessionStorage`, and IndexedDB `app-db` synchronously at parse time, before the app's module, and reports what it saw. Playwright only opens tabs and acts as the user (writing through `window.app`); every capture, clear, and restore runs in the extension.

### Experiment A: restoring before the application starts

Each run: A writes `A-n`, the tab switches to B (start), then back to A (resume); a run fails when the observer's first reads in the first app document after resuming are not exactly `A-n` in all three stores.

Docker, 50 runs per cell (Experiment A runs with Playwright's default, back/forward cache off; history is measured separately below). Switch time is the resume, from the request to the restored state, median / p95 / max in ms.

| Candidate              | Delay   | Page served by | Failures | Observer ran in gate | Gate requests at server | Switch ms          |
| ---------------------- | ------- | -------------- | -------- | -------------------- | ----------------------- | ------------------ |
| A0 (negative control)  | 0 ms    | network        | 50 / 50  | —                    | —                       | 22 / 26 / 30       |
| A0 (negative control)  | 2000 ms | network        | 50 / 50  | —                    | —                       | 2038 / 2050 / 2062 |
| A1, `location.replace` | 0 ms    | network        | 0 / 50   | 0                    | 52                      | 34 / 44 / 46       |
| A1, `location.replace` | 0 ms    | service worker | 0 / 50   | 0                    | 0                       | 38 / 64 / 140      |
| A1, `location.replace` | 2000 ms | network        | 0 / 50   | 0                    | 52                      | 2069 / 2079 / 2080 |
| A1, `location.replace` | 2000 ms | service worker | 0 / 50   | 0                    | 0                       | 2073 / 2087 / 2092 |
| A1, `tabs.update`      | 0 ms    | network        | 0 / 50   | 0                    | 52                      | 32 / 54 / 66       |
| A1, `tabs.update`      | 0 ms    | service worker | 0 / 50   | 0                    | 0                       | 35 / 44 / 50       |
| A1, `tabs.update`      | 2000 ms | network        | 0 / 50   | 0                    | 52                      | 2063 / 2078 / 2089 |
| A1, `tabs.update`      | 2000 ms | service worker | 0 / 50   | 0                    | 0                       | 2075 / 2087 / 2114 |
| A2                     | 0 ms    | network        | 0 / 50   | 0                    | 52                      | 37 / 64 / 98       |
| A2                     | 0 ms    | service worker | 0 / 50   | **52**               | 0                       | 37 / 43 / 52       |
| A2                     | 2000 ms | network        | 0 / 50   | 0                    | 52                      | 2077 / 2094 / 2159 |
| A2                     | 2000 ms | service worker | 0 / 50   | **52**               | 0                       | 2082 / 2102 / 2107 |

52 gate documents per cell: 50 resumes plus the two starts that set the series up. The host run (3 runs per cell) agrees.

- **A0 (negative control)** restores from a content script in the app's own document and fails in every run, even with no added delay: the app's first script always reads before the asynchronous restore. The red control behaves as expected.
- **A1 (gate document)** has no failures in any cell, including the delayed restore and a service worker that serves the navigation from its cache. The observer never ran in a gate document, and with the service worker no gate request reached the server, so the content script halts SW-served documents too. Navigation: the gate URL is the app's URL plus a one-time query marker `__recnrun_gate=<nonce>.<mode>`; a hash marker was not tried, since a hash change alone is a same-document navigation and creates no new document.
- **A2 (CSP header from a DNR rule)** works only when the network serves the document: with the service worker serving it, the header is not applied and the observer ran in the gate. **Rejected**: apps with a service worker (Zephyr) are the target.
- **A3 (offscreen document frame)**: the frame of the origin saw the top-level `localStorage` and `app-db` (not partitioned in this Chromium), but has its own `sessionStorage`, so it cannot restore the tab's. **Rejected** in favor of A1, which reaches every store from the tab itself.

History and `beforeunload`:

- With `tabs.update` and Chrome's back/forward cache, Back twice after A → B **resurrected A's live document over B's storage** (Back once lands on the dead gate URL). The control without a switch confirms the cache was on. With `location.replace` for the gate and the final navigation (injected with `injectImmediately`, because a halted gate document never reaches `document_idle`), the switch leaves no entry for A's document or the gate, and no run resurrected A. **Adopted: `location.replace`.**
- A page with a `beforeunload` handler shows its dialog when the switch navigates away. Accepted, the switch completes. Cancelled, the navigation never commits, the switch times out, and the lab marks the tab unknown although nothing was cleared yet; Phase 3 must report "the page refused to leave" and keep the tab's identity.

### Experiment B: open connections and concurrent writers

The holder writes `A-1`, the tab reloads so the holder opens the existing `app-db`, then the switch clears with `deleteDatabase` (3 s timeout, no probe).

| Holder of `app-db`                     | Outcome                                                                                |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| The app document's own connection      | Not blocked: the connection closes with the document the gate replaced                 |
| A dedicated worker                     | Not blocked (dies with its document)                                                   |
| A shared worker (only client: the tab) | Not blocked                                                                            |
| The service worker                     | **Blocked**: `deleteDatabase(app-db) blocked=true timed out`; the switch fails         |
| A second tab of the origin             | **Blocked**; without the probe the delete **still ran later**, after the holder closed |

- **A late destructive step is real.** `deleteDatabase` cannot be cancelled: once requested, it runs when the holder closes, after the switch was declared failed. With the cancellable probe first (an `open` at version + 1 whose upgrade is always aborted), the switch failed safely: `exclusive access to app-db blocked=true timed out`, A's data intact, A's capture persisted before anything was cleared. **Adopted: probe every database before the first destructive step.** The probe is cancellable only in effect: its `open` cannot be withdrawn either, and stays queued behind the holder after the gate document is gone, so every later `open` of that database (the app's own included) waits until the holder closes its connection (Experiment G). Other databases are unaffected.
- **A service worker holding a connection blocks the switch** as a second tab does. The probe turns that into a safe failure, but the switch stays impossible while the SW keeps the connection. Feasibility restriction: no service worker holding IndexedDB connections.
- **Service worker writes during a switch** (the fixture's SW logs every navigation into `sw-db`): over 20 switches, no write of one identity landed in the other's data. The SW's write for the gate navigation lands in the outgoing identity's capture: observed, not guaranteed, since a SW can write at any time.

### Experiment C: lossless transport

A writes a database whose values are `Date`, `Blob` (typed), `File`, `ArrayBuffer`, `Float64Array` (with `-0` and `NaN`), `DataView`, `Map`, `Set`, `RegExp`, `RangeError`, `BigInt`, `undefined`/`null`/`NaN`/`-0`/`Infinity`, a sparse array, and a boxed `String`; keys that are compound arrays, `Date`, `ArrayBuffer`, `-0`, and the empty string; plus unusual `localStorage` and `sessionStorage` keys and values. A → B → A, then each value is compared by type and content.

| Transport                                 | Outcome                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **T1** structured clone messaging         | Every value and key identical; B started empty                                                                |
| Control: default JSON messaging           | Fails before clearing: `Could not serialize message` (the `BigInt`)                                           |
| Control: JSON, no `BigInt`                | Fails before clearing: the binary key became `{}`, `put … not a valid key` in the background                  |
| Control: JSON, no `BigInt`, no binary key | **Switch succeeds with corrupted data** (Blob, Date, Map, Set, buffers, and others came back as plain values) |

T1 is adopted; T2 (a tagged codec over JSON) is not needed while Chromium ≥ 148 is required. The JSON controls show why a transport must be verified by round trip and never trusted to fail loudly.

**Gap found: the key generator.** An `autoIncrement` store with keys 1–5 where key 5 was deleted continues at 6; after restore it continues at 5, so the app would reuse a key it already gave out. Capture and restore must carry each store's key generator. (Phase 3: read it with an `add` in an aborted transaction and restore it by writing and deleting a record at that key minus one; to be verified.)

Large capture (`ORIGIN_LAB_RECORDS` records of about 1 kB in one store):

| Where  | Records | Suspend A (capture → persisted → done) | Resume A (restore of 10,000 puts) | Count after resume |
| ------ | ------- | -------------------------------------- | --------------------------------- | ------------------ |
| Docker | 10,000  | 222 ms (163 → 186 → 193)               | 565 ms (restore 467 ms)           | 10,000             |

About 10 MB went through one structured clone message without error. Records of several megabytes each were not tried.

### Experiment D: the sign-in host's cookies

The first Zephyr run (below) showed the gap: after `switch B` the extension had cleared `errorDb`, `zephyrOffDb`, and web storage, yet the app came back signed in as A, on its first-run page. Zephyr's storage holds no token (`localStorage` has `user-profile`, `user-roles`, configuration, and feature flags); keycloak-js keeps the tokens in memory and gets new ones from Keycloak on every load, silently, because Keycloak's session cookies on `login-acc.one.be` (`KEYCLOAK_IDENTITY` HttpOnly, `KEYCLOAK_SESSION`, `AUTH_SESSION_ID`, all `SameSite=None`) still named A. Worse, `switch A` after signing in B would restore A's data under B's session.

The fixture reproduces it with a sign-in server on `sso.localhost` and an app page that signs in from it. With `cookieHosts` configured, the background captures that host's cookies (`chrome.cookies.getAll({ domain })`) into the same capture, persists it, and only then removes them and sets the target's, while the gate holds the app off; the gate script gets the target without the cookies.

| Run                            | After A → B              | After B → A                    | After A → B                |
| ------------------------------ | ------------------------ | ------------------------------ | -------------------------- |
| Control, no cookie host        | alice, silently          | alice                          | alice                      |
| `cookieHosts: [sso.localhost]` | login page; bob signs in | alice, profile alice, no login | bob, profile bob, no login |

Cookies per switch with the host: removed 1 / set 0 (start), then removed 1 / set 1 (each resume). Red: the second test failed before the extension swapped cookies (B was alice); green after.

Limits: only unpartitioned cookies whose domain is the host or a subdomain; cookies on a parent domain (`.one.be`) are not taken, since other hosts share them. Restored cookies are only as good as the server session behind them: one that the server ended or let expire (Keycloak's idle timeout) asks for a login again. A tab on the sign-in host outside the RECnRun group would see the swap, so the switch refuses then; one inside the group goes along (Experiment E). This widens the security model: the extension now holds another host's session cookies, HttpOnly ones included.

A group tab left on the sign-in page (B started on two tabs, bob signed in on one) first refused `switch A` with "close the tab on sso.localhost first" (red). Now that tab parks with the group and comes back at the lead's app URL, since its sign-in page belongs to the identity being left: both tabs came back alice, then bob (green, third test).

### Experiment E: a group of tabs

The second Zephyr run worked, until the Agenda menu opened a second tab and the switch was refused ("needs exactly one tab ... found 2 /zephyr-domes-frontend/folder/search, /zephyr-domes-frontend/agenda"). A switch now takes the lead's tab group.

| Check                                                                  | Result                                                                                             |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Tabs opened by the app (a `target="_blank"` link, `window.open`) group | Chrome itself put both in the group (`groupedBy`: none, chrome, chrome); `adopt` is the fallback   |
| A → B → A → B led from a different tab each time, three tabs           | Every tab saw the identity's shared storage and its own `sessionStorage` marker, at its own URL    |
| The popup tab holds an IndexedDB connection                            | Parked first, so the probe was not blocked (before: "app-db blocked=true timed out after 5000 ms") |
| A tab of the origin opened outside the group (`windows.create`)        | Refused, "tabs of http://app.localhost:4330 outside the RECnRun group: /app"; nothing captured     |

Red: E1 failed on the companion's IndexedDB connection, and E2 switched and wiped the outsider's storage. Finding: Playwright's `newPage` sets `openerTabId` to the active tab, so the outsider is opened with `windows.create`.

Each tab's `sessionStorage` is kept per tab id in the capture, and each tab's URL per identity; tab ids do not survive a browser restart, so Phase 3 needs another key (the tab's position in the group, say) if captures must outlive the session. The group title follows the identity (`RECnRun · B`).

### Experiment F: incognito windows

The lab manifest stays in the default spanning mode; the harness turns "Allow in Incognito" on through `chrome://extensions` (`developerPrivate`), because on macOS the setting lives in the signed Secure Preferences and a pre-written profile file does not take.

| Check                                                                   | Result                                                                     |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| A → B → A in an incognito window, the normal window holding its own app | Incognito B started empty, A came back; the normal window kept its storage |
| `switch B` in the normal window afterwards                              | `start`, empty: it did not resume the incognito B                          |
| Sign-in host cookies in incognito (normal window signed in as carol)    | Incognito alice and bob swapped; the normal window stayed carol            |
| Closing the last incognito window                                       | Captures went from `A`, `A (incognito)` to `A`                             |

Red: the normal `switch B` resumed the incognito B and showed its data in the normal window, and the incognito captures were not separated. Green after keying by partition.

Security: while an incognito window is open, its captures sit on disk in the extension's IndexedDB (a spanning extension has one), holding that window's tokens and cookies; they are deleted when the last incognito window closes or, after a crash, at the next start. A split-mode extension would keep them in memory but runs a second service worker. Also fixed here: the gate's `ready` reply carried the whole target, cookie values included, to the page script; it now carries the storage only.

### Experiment G: the person's own Chrome

Asked for by the user, to test in their own Chrome with Gmail. Two gaps showed up before any run there:

- The coordinator keeps identities, groups, and options in the worker's memory, which Chrome clears when it stops an idle worker (Playwright's runs never let it). After a restart (reloading the extension, as the Reload button does) the worker believed the tab was A while it held B: `switch A` was refused with "the tab is already A", and a `switch B` would have saved B's storage as A's capture. Now a switch on an origin that has captures but no known identity refuses ("the lab lost track of ... its service worker restarted; run lab.reset() and start over"), groups are recovered from their `RECnRun · ` titles, and a `preset.json` reconfigures the lab and re-registers the gate at every start.
- Google's session cookies sit on `.google.com`, `accounts.google.com`, and `mail.google.com`. A cookie host now covers its subdomains (host permissions `*://host/*` and `*://*.host/*`), and the origin is checked before the cookie hosts, so with `localhost` as the cookie host the fixture's group tab left on `sso.localhost` came along (red: `toA` took 1 tab and that tab stayed on the login page; green: 2 tabs, both alice, then both bob).

| Check                                                             | Result                                                          |
| ----------------------------------------------------------------- | --------------------------------------------------------------- |
| Switch after the extension reloads, the tab holding B             | Refused, "lost track"; the tab still holds B; captures `A` only |
| Unpacked copy with a preset, `rec.start()`, `rec.switch("B")`/`A` | `RECnRun · A`; B at the login page; A back as alice, no login   |
| `rec.switch("B")` after the copy reloads                          | The preset is back (`rec` exists, gate registered); refused     |

The user's first Gmail run, in their own Chrome 156, found two more:

- `rec.start()` failed with "Tabs can only be moved to and from normal windows": `chrome.tabs.group` without a window uses the worker's current window, which is its DevTools. The group is now created in the tab's own window (red with a focused popup window: "Grouping is not supported by tabs in this window"; green after).
- `rec.switch("B")` failed with "exclusive access to gmail-sw-keyval blocked=true timed out after 5000 ms": Gmail's service worker holds that database, the Experiment B restriction. The probe kept the storage intact, but the cookies had already been swapped when the capture was persisted, so the profile lost its Google session, and the tab stayed on the halted gate document. Now the cookies are swapped only after the storage is cleared, the gate reports `clearing` and waits for the background's answer before it deletes anything, and a switch that fails before that changes nothing: the tabs go back to their URLs and keep the identity, and the error ends with "(nothing changed; the tabs are back)". After `clearing`, a failure still leaves the origin unknown. `rec.restoreCookies(id)` puts an identity's captured cookies back by hand.

| Check                                                             | Result                                                                                                                                                         |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Probe refused by a service worker holding `app-db`, cookie host   | "(nothing changed; the tabs are back)"; tab at its URL; `marker` A-1; `app-db@1`, `sw-db@1`; cookie `who` kept; a retry is refused the same way, not "unknown" |
| `rec.restoreCookies("A")` after switching to B (sign-in at login) | `{ removed: 0, set: 1, expired: 0 }`; after a reload, alice without a login                                                                                    |

In the first check the retry failed with "no report from the a1 script": the gate's capture opens `app-db` too, and waits behind the first probe's queued `open`.

The dashboard (`dashboard.html`, the lab's toolbar button) replaces the console for the person: Start, Switch to a typed or captured identity, Start it empty, Restore cookies, the forced clearing setting (kept in `chrome.storage.local`, applied over the preset at every start), and Forget everything (two clicks). It shows the identity the worker knows, "unknown" after a restart or a failed switch, the site's tabs, and the captures by counts only. Only the dashboard page may send its commands: a message from the app's tab, where the lab's content scripts run, gets "not from the dashboard".

### Experiment H: forcing the release

Asked for by the user after the Gmail refusal. First idea: remove the origin's service worker registration (`chrome.browsingData.remove({ origins }, { serviceWorkers: true })`, new `browsingData` permission) before the probe. It did not free the database: the registration was gone and the page no longer controlled, but the unregistered worker kept running and kept its connection; the probe was still blocked 12 s later, after the gate document stopped being its client (removing it before any tab navigates did not help either). Chrome only stops such a worker when it is idle, about 30 s.

What works: `chrome.browsingData.remove({ origins }, { indexedDB: true })` closes every open connection to the origin's databases (as "Clear site data" does) and deletes them, in 5 ms in the lab. With `forceClear` on (`--force-clear` in the unpacked copy's preset), a switch removes the origin's service worker registration before any tab navigates, so the app's next load registers a fresh worker, skips the probe, and, once the gate reports `clearing` (the capture is already durable), clears IndexedDB through `browsingData`; then the gate clears the rest and restores as before.

| Service worker holding `app-db`, through `rec` with a preset | Result                                                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `forceClear` off (control)                                   | Refused: "exclusive access to app-db … (nothing changed; the tabs are back)"                                 |
| `forceClear` on, A → B, then B → A                           | B starts empty (60 ms), A resumes with A-1 (60 ms); the app's service worker is `activated` again after each |
| `forceClear` on in incognito                                 | Refused, "forceClear is untested in incognito (nothing changed; …)"; without the check it switched           |

Restrictions it adds:

- **The old worker lives on** until Chrome stops it as idle, unregistered and holding the previous identity in memory. It gets no more fetches, but it can still reopen a database and write the previous identity's data into the next one's (restriction 5, wider).
- **Registration state goes with it**: push subscriptions (Gmail's notifications), background sync, and periodic sync belong to the registration, and are lost on every switch; every load after a switch is a cold one.
- **CacheStorage is neither captured nor cleared**: it stays shared by the identities, and may hold one identity's responses.
- The `origins` filter may also reach the origin's storage partitioned under other top-level sites (an embedded `mail.google.com`), which the lab does not capture: untested.
- Incognito: refused, since what `browsingData` clears for a spanning extension in an incognito window is untested.

## Phase 2: intermediate decision

**Proceed with restrictions.** A1 restores before the app's first script in every measured run, with and without a service worker serving the page. The conditions under which that holds:

1. **Gate document** (A1) with a one-time query marker, halted at `document_start`; navigations with `location.replace`.
2. **Structured clone messaging** (T1) from the gate to the background; Chromium 148 or later.
3. **Probe before destroy**: every database gets an exclusive-access probe with a timeout before the first `deleteDatabase`; the capture is persisted (strict durability) before anything is cleared.
4. **The origin's tabs in one RECnRun tab group** (E), all switching together, and **no service worker holding an IndexedDB connection** (Gmail's does), unless forced clearing (H) and its restrictions are acceptable; the switch refuses or fails safely otherwise, and nothing changes until the probe passes, cookies included (G). These are feasibility restrictions, not isolation: two tabs of the origin never hold two identities at once.
5. Service worker writes may land in either identity's data around the switch.
6. **Not captured: CacheStorage and OPFS** (the user's decision after Phase 2, 2026-10-27). They stay shared by the identities; an app that keeps identity data there is not supported. CacheStorage could be captured from the gate except opaque responses (no body to rebuild them), with the service worker stopped (Zephyr's `ngsw` keeps its own state there); OPFS except files held by a `SyncAccessHandle`.
7. **Sign-in host cookies** (D): when the session comes from a sign-in server on another host, its cookies are part of the snapshot (`cookies` permission and host access to that host); without them a switch can silently keep the previous account and mix it with the next identity's data.

Phase 3 additionally owes: refusing a switch to the tab's current identity (the lab accepted B → B once, which would have overwritten B's capture with an empty state on the next switch; fixed in the lab), the key generator, a journal so the coordinator survives a service worker restart (the lab only refuses, G), keys for per-tab state that survive a restart, the incognito purge (F), and `beforeunload` reported as a refusal.

## Zephyr manual run (protocol)

`vp run origin-snapshot-lab:manual -- <url> [--with-host <host>]... [--incognito]` opens a headed Chromium with a temporary profile and the lab extension, its host access set to the URL's origin and each `--with-host`, the exclusive-access probe on, and the first tab in a `RECnRun · A` tab group. Each `--with-host` has its cookies captured and swapped with the origin's storage (Experiment D). `--incognito` turns "Allow in Incognito" on and opens the URL in an incognito window (Experiment F). The terminal takes `switch <identity>`, `reset <identity>`, `inventory [label]`, `captures`, and `quit`; a switch takes every tab of the group (Experiment E), led from the group's active tab on the origin, and its receipt counts them in `tabs`. Output and `.artifacts/origin-snapshot-lab/manual-inventory-<label>.json` hold names, counts, and sizes, never values; captures, which hold tokens and session cookies, stay in the profile that `quit` deletes. A switch is refused while a tab of the origin, or of a `--with-host` host, is open outside the group in the same window kind. The runner finds tabs through the extension, not through Playwright's pages, because on Zephyr the two disagreed once and the switch failed with no tab id.

First run, without `--with-host`: `switch B` cleared `errorDb` and `zephyrOffDb` (not blocked, 218 ms), and the app came back signed in as A on its first-run page (Experiment D explains why). The runner then refused `switch B` again with "the tab is already B". Second run, with `--with-host login-acc.one.be`: the switches worked, until the Agenda menu opened a second tab and the one-tab rule refused (Experiment E).

Steps, with test accounts only:

1. `vp run origin-snapshot-lab:manual -- https://zephyr-tq.one.be/zephyr-domes-frontend/ --with-host login-acc.one.be`. Sign in as A and let the app finish loading its offline data. Run `inventory a`.
2. `switch B`. Expected: Keycloak's login page, with the receipt's `cookies` showing some removed and none set. Sign in as B, let the data load, run `inventory b`.
3. `switch A`. Expected: A's app without a login, A's account and offline data; the receipt shows cookies removed and set. Use the app for a few minutes (navigate, wait for a token refresh) and record whether it stays A.
4. `switch B`. Expected: B without a login, B's data.
5. Open Agenda from the menu. Expected: the new tab joins the `RECnRun · B` group. `switch A`: both tabs come back as A; Agenda stays on Agenda, since it has no page of its own in A. Switch back to B from the Agenda tab.
6. Open the Zephyr URL by hand in a new window (Ctrl/Cmd+N, paste). Expected: `switch A` is refused, naming the outside tab's path; nothing changes. Close that window.
7. `captures` (each identity lists `tabs`) and `quit`.
8. Again with `--incognito`: steps 1 to 5 in the incognito window; `captures` lists the incognito ones only.

What to record: for each step, the account the app shows, any login page or error, the time since that identity was last active (a login page after a long pause may be Keycloak's idle timeout, not a failure of the switch), and the terminal's output. Do not sign out inside the app: it ends that identity's Keycloak session for good. Do not open a tab on `login-acc.one.be` by hand outside the group (the switch refuses). If an inventory lists cookies on `.one.be` or on another host, report their names: the switch does not take them. Close DevTools' IndexedDB view before a switch: if it holds a connection (not verified), the probe blocks and the switch fails without changing anything. A failed switch leaves the tab unknown and refuses further switches; quit and start over.

## Gmail in the person's own Chrome (protocol)

Use two test Google accounts in a new Chrome profile that is not signed in to Chrome. Google accounts in Chrome's own sign-in make Chrome restore Google cookies by itself. The captures hold every `google.com` session cookie of each account, enough to use the account, unencrypted in the extension's IndexedDB on disk until the extension is removed.

1. `vp run origin-snapshot-lab:unpacked -- https://mail.google.com/mail/u/0/ --with-host google.com --force-clear` (without `--force-clear`, Gmail's service worker makes every switch refuse; see Experiment H).
2. In the test profile: `chrome://extensions`, Developer mode on, "Load unpacked", the printed folder. Pin the lab's toolbar button and click it: the lab's dashboard opens in a tab.
3. Sign in to Gmail as A in a tab. On the dashboard, "Start". Expected: the tab joins `RECnRun · A`, and the dashboard shows identity A.
4. Type `B`, "Switch". Expected: Google's sign-in page, and a log line with many cookies removed and none set. Sign in as B and wait for the inbox.
5. "Switch" on A's row: A's inbox without a sign-in. Then on B's row: B's inbox. Open an email in a new tab from Gmail, and switch again: both tabs follow.
6. The captures table lists each identity with counts only.
7. Incognito is not part of this round: forced clearing refuses there (Experiment H), and without it Gmail's service worker refuses every switch.
8. Afterwards: remove the extension (it deletes its captures) and the test profile.

What may stop it, each a finding to record: Gmail dropping the gate's `__recnrun_gate` query parameter (the switch fails after 30 s with "no report from the a1 script", nothing cleared); Gmail's service worker holding an IndexedDB connection (seen in the first run: `gmail-sw-keyval`; the probe blocks, nothing changes, the tabs come back, and Gmail's opens of that database wait until its service worker stops); Google rejecting a restored session (device-bound session credentials, or a "verify it's you" check), which shows as a sign-in page after a switch; partitioned cookies, which the swap does not take. Any other Google tab of the profile (Search, Calendar, Drive) is on the cookie host: outside the group it refuses the switch; inside it, it comes back at Gmail. A switch that fails before clearing changes nothing; one that fails after leaves the origin unknown, and "Forget everything" deletes every capture and starts over. If the cookies are ever wrong, "Restore cookies" on A's row puts A's captured ones back; use it before "Forget everything", which deletes them. The worker's console (`rec`, `lab`) still works, for the specs and for debugging. Do not sign out inside Gmail: it ends that session for good.

## What was exercised

- All four specs, on the host (31 tests, 3 runs per Experiment A cell, 100 large records): 31 passed, 0 failed.
- In Docker with 50 runs per cell and 10,000 large records: 31 passed, 0 failed (`.artifacts/docker/2026-10-27T10-11-55.364Z-ff1bbd70-f662-43b3-8dc3-f0ed194ca05e/run.log`; the JSON evidence stays inside the container, so the tables above come from the JSON lines the specs print). A first Docker run failed 2 of 31 because a spec wrote before the app published `window.app`; the specs now wait for it, and the rerun passed.
- The manual runner on the fixture (headless, scripted commands): inventory, start, resume, reset, captures, and an unknown command. On Zephyr signed out: the inventory of the Keycloak page (cookie names only) and the refusal to switch while the tab is on the sign-in host.
- Experiment D: control and swap, 2 passed on the host and in the full Docker run (33 passed, 0 failed, `.artifacts/docker/2026-10-27T11-29-15.686Z-3aab8329-57c4-4d43-b4eb-5bf5b7410b84/run.log`, 50 runs per Experiment A cell); red before the extension swapped cookies (B came back as alice), green after. The manual runner with `--with-host sso.localhost` on the fixture (a scratch copy with navigation commands, scripted): B started at the login page, bob signed in, a tab on the sign-in host refused the switch, A came back as alice and B as bob, and `captures` listed cookie names only.
- Experiments E and F, the sign-in tab test in D, and the whole lab: 39 passed on the host and in Docker (`.artifacts/docker/2026-10-27T13-04-44.062Z-2b59ebac-2f70-4953-8d65-5f55f206692e/run.log`), red before each change as described above. The first host run of the whole lab caught a regression in A0: the `ready` reply no longer carried the target, so A0 restored nothing (`Cannot read properties of undefined (reading 'local')`) and its delayed run stopped losing the race; A0 now gets the storage-only target there, and loses all 50 runs at both delays again.
- Experiment G and the parent-domain cookie host: 42 passed on the host and in Docker (`.artifacts/docker/2026-10-27T13-45-40.450Z-6ff81940-5021-4583-9634-6d52d6e00a8a/run.log`), red before each change (the restart test failed with "the tab is already A", the preset test found no `rec`, the `localhost` cookie host left the sign-in tab behind). `vp run origin-snapshot-lab:unpacked -- https://mail.google.com/mail/u/0/ --with-host google.com` wrote the copy with host permissions `https://mail.google.com/*`, `*://google.com/*`, `*://*.google.com/*` and the preset; the user's Chrome is 156.
- The user's first Gmail run and its fixes: 45 passed on the host and in Docker (`.artifacts/docker/2026-10-27T14-42-06.053Z-8d47458b-24e4-4d9c-8f1a-0e8d2dffbb27/run.log`), red before each change (the focused popup window: "Grouping is not supported by tabs in this window"; the refused probe left the tab on the gate document; `rec.restoreCookies` did not exist). By hand on the host: after the refusal, an `open` of `app-db` hung for 8 s while a new database opened at once.
- The manual runner on the fixture with `--with-host sso.localhost`, in a normal window and with `--incognito` (a scratch copy adding navigation, `window.open`, new-window, and close commands, scripted): a tab opened from the app joined the group; `switch B` took 2 tabs to the login page; bob signed in on one; `switch A` took both back to alice, the one left on the sign-in page included; a tab of the origin opened in a new window refused `switch B` with its path; after closing it `switch B` gave bob on both; `captures` listed `tabs: 2` and cookie names, the incognito run only `(incognito)` captures; `inventory` read the incognito cookie store through the extension.
- Experiment H and the dashboard: 50 passed on the host and in Docker (`.artifacts/docker/2026-10-27T15-32-04.008Z-03e655e6-51a6-464c-b7b0-1b05d3931190/run.log`; H alone 48 passed in `.artifacts/docker/2026-10-27T15-17-47.131Z-de176e66-16a3-4cf5-b1ad-0a043ee89690/run.log`), red before each change (with the incognito guard removed the H spec saw "switched"; before the dashboard existed its spec found no page). By hand: the dashboard's screenshot from the spec renders the site, identity, captures, settings, and log. The unpacked copy was regenerated with `--force-clear` for the user's Gmail round.
- Negative controls: A0 (fails as expected), the JSON transport (fails or corrupts as expected), and the unprobed second tab (late delete reproduced).
- Zephyr signed in, first run (by the user, without `--with-host`): the inventory and `switch B`, which kept A signed in. Second run (by the user, with `--with-host login-acc.one.be`): the switches worked; a second tab from the Agenda menu was refused.
- Not exercised: Zephyr with the tab group or `--incognito`, Gmail past the first switch, the fixed switch and Experiment H on Gmail, and the dashboard in the user's Chrome (all need the user's accounts), whether the old service worker writes into the next identity before it stops, `browsingData` on the origin's partitions under other top-level sites, a real idle stop of the worker (the specs reload the extension instead), Secure, domain, and expired cookies in the fixture (Zephyr's are Secure, host-only), and a cancelled `beforeunload` dialog (Playwright accepted it; the cancelled path is inferred from navigation semantics).
