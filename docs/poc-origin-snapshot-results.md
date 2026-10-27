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

- **A late destructive step is real.** `deleteDatabase` cannot be cancelled: once requested, it runs when the holder closes, after the switch was declared failed. With the cancellable probe first (an `open` at version + 1 whose upgrade is always aborted), the switch failed safely: `exclusive access to app-db blocked=true timed out`, A's data intact, A's capture persisted before anything was cleared. **Adopted: probe every database before the first destructive step.**
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

## Phase 2: intermediate decision

**Proceed with restrictions.** A1 restores before the app's first script in every measured run, with and without a service worker serving the page. The conditions under which that holds:

1. **Gate document** (A1) with a one-time query marker, halted at `document_start`; navigations with `location.replace`.
2. **Structured clone messaging** (T1) from the gate to the background; Chromium 148 or later.
3. **Probe before destroy**: every database gets an exclusive-access probe with a timeout before the first `deleteDatabase`; the capture is persisted (strict durability) before anything is cleared.
4. **One tab of the origin**, and **no service worker holding an IndexedDB connection**; the switch refuses or fails safely otherwise. These are feasibility restrictions, not isolation.
5. Service worker writes may land in either identity's data around the switch.

Phase 3 additionally owes: the key generator, a journal so the coordinator survives a background restart, refusing early when another tab of the origin is open (`tabs.query`), and `beforeunload` reported as a refusal.

## Zephyr manual run (protocol)

`vp run origin-snapshot-lab:manual -- <url>` opens a headed Chromium with a temporary profile and the lab extension, its host access set to the URL's origin, the exclusive-access probe on, and the tab's first identity named A. The terminal takes `switch <identity>`, `reset <identity>`, `inventory [label]`, `captures`, and `quit`. Output and `.artifacts/origin-snapshot-lab/manual-inventory-<label>.json` hold names, counts, and sizes, never values; captures, which hold tokens, stay in the profile that `quit` deletes. A switch is refused unless Chrome shows exactly one tab on the origin; the refusal lists the tabs' paths. The runner finds that tab through the extension, not through Playwright's page, because on Zephyr the two disagreed once and the switch failed with no tab id.

Steps, with test accounts only:

1. Start the runner on `https://zephyr-tq.one.be/zephyr-domes-frontend/` and sign in as test account A; let the app finish loading its offline data. Run `inventory a`.
2. `switch B`. B starts empty, so the app goes to Keycloak. Record whether Keycloak asks for credentials or signs A in again on its own (its cookies were not switched).
3. If Keycloak asked, sign in as B. If it signed A in, the session cookies of the sign-in host decide the account, which the snapshot cannot change; to go on, sign out of Keycloak from the app or delete the `login-acc.one.be` cookies in DevTools by hand, sign in as B, and record which you did (signing out may end A's server session too). Run `inventory b`.
4. `switch A`. Record whether A's app opens without a sign-in, shows A's account and offline data, and stays signed in for a few minutes (token refresh and Keycloak's session checks use the sign-in host's cookies, which are now B's).
5. `switch B`, then `switch A` once more, recording the same. Run `captures`, then `quit`.

What to record: for each step, the account the app shows, any sign-in page or error, and the terminal's output. Close DevTools' IndexedDB view before a switch: if it holds a connection (not verified), the probe blocks and the switch fails without changing anything. A failed switch leaves the tab unknown and refuses further switches; quit and start over.

## What was exercised

- All four specs, on the host (31 tests, 3 runs per Experiment A cell, 100 large records): 31 passed, 0 failed.
- In Docker with 50 runs per cell and 10,000 large records: 31 passed, 0 failed (`.artifacts/docker/2026-10-27T10-11-55.364Z-ff1bbd70-f662-43b3-8dc3-f0ed194ca05e/run.log`; the JSON evidence stays inside the container, so the tables above come from the JSON lines the specs print). A first Docker run failed 2 of 31 because a spec wrote before the app published `window.app`; the specs now wait for it, and the rerun passed.
- The manual runner on the fixture (headless, scripted commands): inventory, start, resume, reset, captures, and an unknown command. On Zephyr signed out: the inventory of the Keycloak page (cookie names only) and the refusal to switch while the tab is on the sign-in host.
- Negative controls: A0 (fails as expected), the JSON transport (fails or corrupts as expected), and the unprobed second tab (late delete reproduced).
- Not exercised: the Zephyr inventory and any run against Zephyr (needs a manual sign-in with a test account), and a cancelled `beforeunload` dialog (Playwright accepted it; the cancelled path is inferred from navigation semantics).
