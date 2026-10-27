# RECnRun — POC: Origin snapshots (switch one origin's local state in one tab)

## Objective and scope

Find out whether the extension alone (Chrome MV3, no companion app, no backend, no `chrome.debugger`, no CDP in the implementation) can switch **sequentially** between saved local states of one web application, in one tab and one origin, and prove it with the flow **A → B → A → C → A**, every identity keeping its data.

An **identity** is a set of local data: cookies, `localStorage`, `sessionStorage`, IndexedDB, and CacheStorage of one origin. Restoring it does not restore a valid server session: tokens may expire or be revoked, and the report says when that happens.

The order is: **first prove that a switch can restore state before the application starts; only then build the adapters and the UI.** A demonstrated limitation is a valid result, NO-GO included. Do not simulate success, and do not run the whole plan if the experiments of Phase 1 find a blocking limitation: stop at the decision gate and report.

### Constraints

- No companion app, support backend, `chrome.debugger`, or CDP in the extension.
- Playwright drives the browser with its normal automation (and may use CDP for fault injection, such as stopping the extension's service worker), but never captures, clears, restores, or suspends application state itself: the extension does.
- Do not modify the application under test to cooperate with the switch. The fixture app has observation-only instrumentation: it never waits for a signal, never delays its start, and has no special restore route.
- No incremental snapshots, OPFS, sync, compression, or complex rollback. No extensive monkey patching of page APIs.
- Test data and test accounts only. Captures of a real application contain its tokens: they stay in ignored folders (`.artifacts/`), are never committed, uploaded, or pasted into the report, and are deleted after the run. The report lists names, counts, and sizes, never values.
- Code, docs, diagnostics, and UI in English.

### How this differs from the single-tab POC

`poc/single-tab-multi-user` ([its report](https://github.com/RECnRun/recnrun/blob/poc/single-tab-multi-user/docs/poc-single-tab-sessions-results.md); locally `git show poc/single-tab-multi-user:docs/poc-single-tab-sessions-results.md`) already passed A → B → A → C → A in one tab. Its swap mode moved cookies with `chrome.cookies`, but kept page storage apart with a **prelude** that prefixed every storage API per identity (a namespace), so nothing was copied. This POC tests the opposite design: **no prelude; the origin's real storage is captured, cleared, and restored** at each switch, so the app sees ordinary, unprefixed storage, workers and the service worker included.

Reuse, reimplemented here (do not merge or cherry-pick): the neutral navigation and its commit wait, the cookie save, empty, and restore of `swap.js`, the request drain of `network-idle.js`, the block rule of `sessions-block.js`, the one-queue switch of `sessions.js`, and the headed manual run of `single-tab/manual.mjs`. Read them with `git show poc/single-tab-multi-user:scripts/containers-lab/extension/<file>`.

## Prepared workspace

- Worktree: `/Users/dannyelcf/src/recnrun-origin-snapshot-poc`.
- Branch: `poc/origin-snapshot`, from `44c154d` (`master`).
- Plan: `docs/poc-origin-snapshot-plan.md` (this file).
- Report: `docs/poc-origin-snapshot-results.md`.

The worktree exists; do not recreate it or switch the primary checkout. Run `vp install` first. Keep every change in this worktree. Do not push or change global configuration. Read `AGENTS.md`, `CLAUDE.md`, `.claude/rules/extension.md`, `.claude/rules/tests.md`, `.claude/rules/domain.md`, [ARCHITECTURE.md](ARCHITECTURE.md), [PRODUCT_BRIEF.md](PRODUCT_BRIEF.md), and [POCS.md](POCS.md) before writing code. Tests run in Docker; never bypass hooks or weaken a gate.

## Validation targets

| Target                                                     | Role                                                       | Where it runs                                             |
| ---------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------- |
| Fixture app (`http://app.localhost:<port>`, ours)          | Every automated experiment and test, red/green             | Docker (Xvfb), Playwright Chromium                        |
| Zephyr (`https://zephyr-tq.one.be/zephyr-domes-frontend/`) | Field check of the mechanism on a real IndexedDB-heavy app | Host, headed Chromium, disposable profile, manual sign-in |

**Zephyr, as observed on 2026-10-27** (to confirm in Phase 0):

- Angular SPA under the path `/zephyr-domes-frontend/` on the origin `https://zephyr-tq.one.be` (`<base href>`, `ngsw.json` answers 200), served by Apache, a PWA (`manifest.webmanifest`).
- Angular service worker: two `prefetch` asset groups (265 and 570 URLs), **no `dataGroups`**, and `navigationUrls` that exclude paths with a dot or with `__` in their last segment.
- DevTools (user's profile): IndexedDB 4.1 MB (`errorDb`, `zephyrOffDb` with stores such as `accident`, `adressePersonnePhysique`, `alimentation`, `avisDemandes`, `beneficiaire`, `beneficiairesEvenement`, `biometrie`, … and `beneficiaireId` indexes), CacheStorage 21.9 MB, service workers 83.4 kB.

Consequences the plan must test, not assume:

- The 21.9 MB of CacheStorage is most likely the service worker's app shell (`ngsw:*` caches), not identity data. Restoring an older shell or the SW's control caches could fight the SW's own version handling. Phase 3 measures a switch with every cache included and one with an explicit, configurable exclusion (`ngsw:*`), and reports the difference.
- The SW is alive during a switch (a navigation wakes it) and is a concurrent writer (Experiment B).
- The snapshot is per origin: anything else hosted on `https://zephyr-tq.one.be` is switched too. Phase 0 lists what else the origin's storage holds.
- Sign-in likely goes through another host (an identity provider). Its cookies are outside the origin; the report says whether an identity resumes signed in, signs in again silently, or must sign in by hand.
- Use only the test accounts the user provides; the user signs them in by hand in the manual run. No credential goes in a file.

## Where the code lives

- **Phase 1 (experiments)** runs in a lab: a separate unpacked MV3 extension, a fixture server, and `node --test` Playwright specs under `scripts/origin-snapshot-lab/` (plain ES modules), with `test:origin-snapshot-lab` (Docker, through `scripts/test-container.mjs`) and `test:origin-snapshot-lab:local` scripts, as `test:single-tab` did. Fault injection (delays, failures) is a lab handle on the service worker. Nothing under `apps/` or `packages/` changes in Phase 1, and the production manifest guard keeps passing.
- **Phase 3 (implementation)**, only after a favorable decision, moves the proven mechanism into `apps/extension` and `packages/domain`, under the normal gates (coverage floors, lint caps, dependency-cruiser), with end-to-end tests in `tests/e2e`. The new permissions exist only in `development` and `test` builds; the production manifest, and `apps/extension/scripts/manifest.checks.mjs`, stay unchanged. If that split is not workable, stop and ask.

### Naming

The domain already has `Snapshot` (the stored recordings). Do not reuse the word in new identifiers: the stored state of an identity is an `OriginCapture` (schema `OriginCaptureSchema`), and an identity is `OriginIdentity`. Prose may say "origin snapshot".

### Permissions (lab first; Phase 3 only what survived)

| Permission                    | Used for                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| `scripting`                   | The gate content script, registered only during a switch (`registerContentScripts`)       |
| `cookies`                     | Capture, clear, and restore the origin's cookies (partitioned ones included)              |
| `tabs`, `webNavigation`       | Navigate the tab, wait for commits, know each `documentId`; find other tabs on the origin |
| `webRequest`                  | Drain the tab's pending requests before capture                                           |
| `declarativeNetRequest`       | Block the tab after a failed switch; candidate A2 (response header)                       |
| `storage`, `unlimitedStorage` | The switch journal; extension IndexedDB holding captures of many megabytes                |
| `offscreen`                   | Candidate A3 only                                                                         |
| Host permissions              | The fixture origin; Zephyr's origin only in the manual run's copy of the manifest         |

### Security model change (document it)

Today RECnRun never reads another application's storage, and its content script runs only on recnrun.com as a relay that never touches storage. This POC adds a second content script that runs on the application's origin and reads and writes that origin's storage, and the extension stores those captures (session tokens included). Keep three parts separate and say so in [ARCHITECTURE.md](ARCHITECTURE.md) in Phase 3:

1. Scripts that run in the application's pages (the gate): read and write page storage, receive and send captures only to the background, never touch extension storage.
2. Extension-owned persistence (background): validates every capture with the domain schema where it enters, stores it, never exposes it to a web page.
3. The public website and the bridge: never receive a capture; no bridge message carries one.

## Phase 0: Reconnaissance (no code)

1. Read the messaging (`src/background/listener.ts`, `routes.ts`, `src/messaging/*`), storage (`src/storage/*`), tab handling (`src/tabs`), and the e2e infrastructure (`tests/e2e/fixtures/*`, `playwright.config.ts`, `scripts/test-container.mjs`, `Dockerfile.tests`).
2. Record the Playwright Chromium version in the Docker image and on the host, and whether WXT can express runtime-registered content scripts (`registration: "runtime"`) and any manifest key that structured clone messaging needs.
3. List the permissions above against what each experiment needs, and how to limit host permissions to the POC origins.
4. Zephyr inventory, in a disposable profile after a manual sign-in with a test account, from DevTools or a throwaway snippet in the console (names, counts, and sizes only): `indexedDB.databases()` with versions, stores, key paths, `autoIncrement`, indexes, and record counts; `localStorage` and `sessionStorage` key names and sizes; cookies (name, domain, path, flags, partitioned) on the origin and on the sign-in host; `caches.keys()` with entry counts; the service worker's scope and state; and anything outside `/zephyr-domes-frontend/` on the origin. Note which data looks like identity (tokens, user, offline records) and which looks like app shell.

Output: a short Phase 0 section in the report.

## Phase 1: Feasibility experiments

### Fixture app

`scripts/origin-snapshot-lab/fixture/` serves the app on `http://app.localhost:<port>` and a second origin for negative checks. Its first `<head>` script is the observer: synchronously, before anything else, it reads `localStorage` and `sessionStorage`, starts `indexedDB.open` of every known database and reads a marker record, and reports what it found (to a fixture endpoint with `sendBeacon` and to `window.__observed`), with `performance.now()` timestamps. Optional switches on the fixture (query flags set by the spec, not by the extension) add: a long-lived IndexedDB connection, a dedicated worker, a shared worker, and a service worker that writes to IndexedDB and CacheStorage on `fetch` and on a timer.

### Experiment A: restoring before the application starts

The extension delays its restore by a controlled amount (lab handle, 0 ms and 2,000 ms) so a race is reproducible. For each candidate, show where the restore code runs, how it reaches the right storage partition, what stops the application from touching storage meanwhile, and when the application may start.

| Candidate | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Expected                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| A0        | Content script at `document_start` in the application's own document restores asynchronously. **Negative control.**                                                                                                                                                                                                                                                                                                                                                       | Fails with the delay: the observer reads the previous or empty state                                       |
| A1        | **Gate document.** The tab navigates to the app's URL with a one-time marker (`#__recnrun_gate=<nonce>`, and a variant with a query parameter). A content script registered for the switch (`document_start`, isolated world) sees the marker, checks the nonce with the background, calls `window.stop()` and empties the document, so no page script ever runs. It captures, clears, and restores the origin's storage there, then the tab navigates to the target URL. | The observer's first reads see the restored state; the observer never runs in the gate document            |
| A2        | DNR rule adding `Content-Security-Policy: script-src 'none'` to the marker URL's main-frame response; the same content script works in the scriptless document.                                                                                                                                                                                                                                                                                                           | Works only for network responses; measure with the fixture's service worker serving the navigation         |
| A3        | An offscreen extension document frames the app's origin (with A1's gate in the frame).                                                                                                                                                                                                                                                                                                                                                                                    | Check whether the frame gets the first-party storage partition; it cannot reach the tab's `sessionStorage` |

Hypotheses for A1, each to measure: the content script runs before any parser-inserted script, even when the service worker serves the HTML; `window.stop()` at `document_start` prevents every inline and external script; the gate document shares the tab's `sessionStorage`; a document that the Angular service worker serves (Zephyr) behaves the same. Zephyr's `navigationUrls` exclude `__` segments, so a path such as `/zephyr-domes-frontend/__recnrun_gate` would bypass its SW and reach Apache: note it as an app-specific fact, never as the mechanism.

Criterion: the observer's **first** reads in the first application document after the switch see the restored state. A correct value only after a second reload does not count. Run each candidate at least 50 times per delay and report runs and failures; repeated success is evidence, not a guarantee.

Also record: the history entries a switch leaves (Back from B must not resurrect A's document over B's storage; check what Back to the gate URL and the back/forward cache do, and that `tabs.update` versus `location.replace` changes them), and a page with a `beforeunload` handler.

### Experiment B: open connections and concurrent writers

Test each separately: an IndexedDB connection held by the app; a second tab on the origin; a dedicated worker and a shared worker holding a connection or writing; the fixture's service worker writing during the switch. Check whether unloading the app document (the gate navigation) really frees what matters.

- Detect `blocked` and `versionchange`, put a timeout on every step, and make sure an operation that arrives late cannot change data after the switch was declared failed. `deleteDatabase` cannot be cancelled once requested: measure a cancellable probe first (an `open` at a higher version whose upgrade is aborted on purpose, which leaves the version unchanged) and only then the destructive step.
- Do not assume that unregistering a service worker stops its running work; measure what a SW does between capture and restore.
- Other tabs on the origin: detect them (`tabs.query`) and refuse the switch.

The basic scenario may require one tab and no concurrent writer. Record those as **feasibility restrictions**, not as isolation.

### Experiment C: lossless transport

Prove the path **app IndexedDB → gate content script → background → extension IndexedDB → back** before any full backup. Cover `Date`, `Blob` (with type), `ArrayBuffer`, typed arrays, compound (array) keys, `null`/`undefined`, nested objects, and records of a few megabytes.

| Variant | Transport                                                                                                                                                                                    |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1      | `runtime` messaging or a `Port` with Chrome's structured clone opt-in, if the Chromium in use and WXT support it (confirm the version, the manifest key, and the size limit; chunk by store) |
| T2      | The default JSON messaging with an explicit, versioned, tagged codec (for example `{ "$t": "date" }`, bytes for `ArrayBuffer` and `Blob`), validated with Valibot at the background          |
| T3      | Note only unless T1 and T2 fail: a web-accessible extension frame with a `MessageChannel`; record why a page could reach that frame                                                          |

A value the transport cannot carry fails the capture with a named error, or the supported scope shrinks and the report says so. Never convert silently: compare each round-tripped value with the original by type and content.

## Phase 2: Decision gate

Write the intermediate decision in the report and **stop to tell the user** before Phase 3:

- **Proceed:** a mechanism demonstrably restores before the application starts.
- **Proceed with restrictions:** it works under explicit conditions (for example one tab, no SW writing).
- **Stop expanding:** an essential condition stays infeasible. Deliver the reproducible experiment and the conclusion; do not build the remaining adapters to complete the list.

## Phase 3: Progressive implementation

Only after the user agrees with the decision. Each step ends with its tests green; keep responsibilities apart without one class per name in this plan.

1. IndexedDB adapter and the extension's capture repository.
2. Coordinator and the flow A → B → A.
3. `localStorage` and `sessionStorage`.
4. Cookies.
5. CacheStorage.
6. Full flow A → B → A → C → A and a minimal UI.

### IndexedDB

- Keep names, versions, stores, key paths, `autoIncrement`, indexes (unique, multi-entry), keys, and supported values.
- Capture each database in one `readonly` transaction over all its stores (consistency per database). No atomicity across databases or across storage APIs: say so.
- Confirm a restore only on `transaction.oncomplete`. Close every connection the extension opened.
- Compare `clear()` per store, `deleteDatabase()`, and rebuilding inside a `versionchange` transaction, against a target with a different schema, a lower version, and extra databases that the target lacks.
- **Key generator.** Create records, delete the highest key, capture, restore, then add without a key. Clearing or deleting records does not lower the generator ([IndexedDB](https://w3c.github.io/IndexedDB/)), so restoring the records alone may not restore it. Hypothesis to test: capture the generator by adding a record in a `readwrite` transaction and aborting it (an abort reverts the generator), and restore it by writing and deleting a record at the captured key minus one. Record any difference.

### Other storage

- **`localStorage`:** capture every entry; restoring removes the keys the target does not have.
- **`sessionStorage`:** same tab only. Do not promise anything after the tab closes unless shown.
- **Cookies:** scope by domain, path, cookie store, and partition key. Never clear more than the configured domains; record cookies whose domain is wider than the origin (a parent domain), which no longer fit the "origin" model.
- **CacheStorage:** state which requests and responses are supported (method, opaque responses, `Vary`, body types), test binary bodies, and list what cannot be rebuilt. Measure Zephyr with every cache and with the `ngsw:*` exclusion.

### Coordinator and failures

Reference flow, to adjust after Phase 1:

1. Validate the tab, the origin, the permissions, and the target (Start of a new, empty identity or Resume of an existing one; Reset is explicit).
2. Take a lock for the origin; a second request waits or is refused.
3. Unload the app (the gate navigation), drain its requests.
4. Capture the current state.
5. Persist one complete capture and confirm it (`oncomplete`, strict durability).
6. Clear and restore the target.
7. Let the application start (navigate to the target URL).
8. Confirm and release the lock.

**Never clear before the current state is persisted.** A missing capture on Resume is an error, never a silent Start. Record whether writes between step 3 and step 4 can still happen (SW, other contexts) and, if they cannot be prevented, the limitation.

Keep a journal of the switch's phase in extension storage, not in memory. After the extension's service worker restarts mid-switch, or after a destructive failure, the tab is in **unknown state or incomplete restore**: block it (DNR rule, as the single-tab POC did), never mark an identity active, never continue on its own. Test stopping the service worker at each phase.

### UI

One "Switch identity" action per the single-tab POC's decision: the developer picks an identity; RECnRun decides Start or Resume; Reset is explicit; the destination URL is per step. Show the phase, failures, and the unknown state.

## Phase 4: Validation

Red/green per `AGENTS.md`: every behavior test fails first against an unfixed or controlled broken state (in a scratch copy, never left in the code), then passes. Cover:

- A → B → A → C → A, and the update of A's capture on every suspend.
- Several databases, different schemas, extra databases, empty stores, indexes, and keys.
- Structured types and the key generator.
- Failures injected at capture, persistence, clearing, and restore.
- Concurrent switch requests; `blocked`, timeouts, and the extension's service worker stopped mid-switch.
- The application's first read after a restore.
- Closing and reopening the tab.

Compare schemas, keys, and values with an independently built expected state, including the absence of the other identities' data.

**Load:** at least 10,000 records (state the composition and the approximate size, for example several stores, strings, dates, nested objects, and some `Blob`s). Measure separately: capture, transport, persistence, clearing, restore, and the total switch, with the median and the worst of several runs.

**Zephyr run** (host, headed, disposable profile, manual sign-in with the user's test accounts): the inventory, then A → B → A → C → A with three accounts. After each switch: whether the app opens signed in, store-by-store record counts of `zephyrOffDb` and `errorDb` match the identity's capture, and data an identity created offline is absent for the others; the switch times; and the CacheStorage policy comparison. Delete the captures afterwards.

Real tests run in Docker. Code delivery requires `vp run verify` to exit 0.

## Deliverables

Code only up to the step the evidence justifies, and `docs/poc-origin-snapshot-results.md` in English with:

- browser and environment versions (Docker and host, Chromium build);
- the strategy actually implemented and the candidates rejected, with why;
- permissions and architecture changes;
- red/green commands and outcomes;
- results of Experiments A, B, and C (runs, failures);
- measured times and sizes;
- supported features and limitations, Zephyr's included;
- a verdict: **GO**, **CONDITIONAL GO**, or **NO-GO**.

The conclusion separates:

1. fidelity of the restored data;
2. restore before the application starts;
3. interference from other contexts (tabs, workers, service worker);
4. local storage versus authentication on the server.

**Do not claim simultaneous isolation between tabs of one origin. Do not generalize from the fixture or from Zephyr to unknown applications.** Add the POC to [POCS.md](POCS.md) when it ends.
