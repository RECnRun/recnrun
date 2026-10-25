# RECnRun — POC: Tab-group containers (isolated sessions in one Chrome profile)

## Objective and scope

Find out whether the extension alone, in one ordinary Chrome profile and with no browser flags, can turn each tab group into a "container" with its own cookies, every kind of web storage, service workers, and shared workers. A developer could then be signed in to the same site as four different users at once, one per group.

This is the alternative to `poc/chrome-cdp-browser-contexts` (worktree `/Users/dannyelcf/src/recnrun-cdp-poc`), which uses real CDP BrowserContexts. Chrome has no container API (Firefox has `contextualIdentities` and per-container `cookieStoreId`; Chrome's `cookies` API only knows the normal and incognito stores). Everything here is emulation: rewriting cookies at the network layer, plus virtualizing storage APIs inside the page. A demonstrated leak, race, or Chrome restriction is a valid result. Do not simulate success.

**Threat model.** The containers keep a cooperative application (the developer's own app) from sharing state across identities by accident. They are not a security boundary against hostile page script; a page that tries to escape the virtualization (for example through a fresh `about:blank` realm) is a measured limitation, not a defect to hide.

**Out of scope, recorded as shared.** IP and fingerprint, the HTTP authentication cache, TLS client certificates, HSTS, the password manager and autofill, site permission grants, FedCM, and WebAuthn credentials. List them in the report as shared across containers; measure the HTTP cache (see Phase D).

## Prepared workspace

- Worktree: `/Users/dannyelcf/src/recnrun-tab-containers-poc`.
- Branch: `poc/tab-group-containers`.
- Initial base: `44c154d` (`Merge pull request #12 from RECnRun/improvement-plan`).
- Plan: `docs/poc-tab-group-containers-plan.md`.
- Final report: `docs/poc-tab-group-containers-results.md`.

The worktree and branch already exist. Inspect their status; do not recreate them or switch the primary checkout. Keep every change inside this worktree. You may read the CDP POC branch for patterns (`git show poc/chrome-cdp-browser-contexts:scripts/cdp-lab/lab-chrome.mjs`, `fixture-server.mjs`, `lab-extension.mjs`) and reimplement what you need here; do not merge or cherry-pick it. Do not push, publish, or change global configuration.

Read `AGENTS.md`, `CLAUDE.md`, the scoped rules (`.claude/rules/extension.md`, `tests.md`), [ARCHITECTURE.md](ARCHITECTURE.md), [PRODUCT_BRIEF.md](PRODUCT_BRIEF.md), and [POCS.md](POCS.md) before implementation. All committed code, diagnostics, UI, and docs are in English. Run `vp install` first. Tests run in Docker; never bypass hooks or weaken checks.

## Where the lab lives

The production manifest stays as it is: `vp run test:extension-manifest` must keep passing. The lab is a separate unpacked MV3 extension under `scripts/containers-lab/` (plain ES modules, like `scripts/cdp-lab/`), with only the permissions its experiments need and host permissions limited to the fixture origins:

| Permission                                      | Used by                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `tabGroups`, `tabs`, `webNavigation`            | Container assignment: groups, openers, popups                      |
| `declarativeNetRequestWithHostAccess`           | Variant N1: per-tab `Cookie` and `Set-Cookie` rules                |
| `webRequest`                                    | Variant N1: observing `Set-Cookie` (`extraHeaders`)                |
| `debugger`                                      | Variant N2: `Fetch`, `Network`, `Page`, `Target` on container tabs |
| `scripting` (and `userScripts` if B4 is tested) | MAIN-world page prelude                                            |
| `storage`                                       | Container registry and cookie jars                                 |

Branded Chrome 137 and later ignore `--load-extension`; drive experiments with Playwright's Chromium or Chrome for Testing, and record the exact build. Check that tab groups and `chrome.tabGroups` behave the same there. A manual run in branded Chrome loads the lab from `chrome://extensions` in a disposable profile, never the user's own.

Only domain logic worth keeping (cookie matching, the container state machine) may move into `apps/extension/src` or a package, with tests; that would be an architecture change and follows the ARCHITECTURE.md and `.dependency-cruiser.cjs` rule. The POC does not need it.

## Design under test

### Containers and tab assignment

- Five slots: four tab groups, one per fictional identity (Admin, Requester, Approver, Supervisor, the same workflow as the CDP POC for comparison), and ungrouped tabs as a **control** that keeps Chrome's native storage and must never see container state.
- A container has a stable id in extension storage. Tab group ids do not survive a browser restart; map groups to containers by title (and color) and record what restart, session restore, and "Reopen closed group" do to that mapping.
- Assignment sources, each measured for timing against the tab's first request: `tabGroups`/`tabs.onUpdated` (`groupId`), `tabs.onCreated` (`openerTabId`), `webNavigation.onCreatedNavigationTarget` (`window.open`, `target=_blank`, popups that open in a new window outside the group, such as OAuth popups), duplicated tabs, and Ctrl/Cmd-click.
- Moving a loaded tab to another group changes its container. In-memory page state still belongs to the old one, so the policy under test is "reload on move"; measure what leaks if the reload is skipped.

### Layer 1: network cookies

Chrome sends the profile's own jar on every request, so the container's jar must replace the `Cookie` request header and capture and strip `Set-Cookie` before it reaches the real jar. Test two variants side by side; a third is a note only.

- **N1, declarativeNetRequest and webRequest (no debugger).** Per-container session rules with `condition.tabIds` set the `Cookie` request header and remove `Set-Cookie` from responses; `webRequest.onHeadersReceived` with `["responseHeaders", "extraHeaders"]` observes the removed headers and updates the jar, then the rules. Hypotheses to verify: DNR may remove `Set-Cookie`; a non-blocking listener still sees the header DNR removed; `websocket` requests honor the rule. Expected risks: rule updates are asynchronous, so the request after a `302` that sets the session cookie (a login redirect) may leave with the old jar; header values are static, so per-domain and per-path matching needs one rule per host and path; requests with `tabId: -1` (service workers, shared workers, some prefetches, `sendBeacon` after the tab closes) match no tab rule.
- **N2, `chrome.debugger` per container tab.** `Fetch.enable` at the request and response stages builds the exact `Cookie` header for each request from the container's jar and strips and captures `Set-Cookie` in the response, so there is no race. The same session gives `Network.setBypassServiceWorker`, `Network.setCacheDisabled`, `Page.addScriptToEvaluateOnNewDocument` (Layer 2 bootstrap), and `Target.setAutoAttach` with `flatten` and `waitForDebuggerOnStart` for out-of-process frames and dedicated workers. Costs to record: Chrome's "started debugging this browser" infobar, the `debugger` install warning, coexistence with DevTools open on the same tab and with any RECnRun recording that uses the debugger, and per-request latency.
- **N3, `webRequestBlocking`** (note only). In MV3 it is limited to policy-installed extensions. Check once whether an unpacked load gets it; it is not a Chrome Web Store path.

**Jar.** One jar per container in `storage.local` (decide and record whether containers survive a restart), with RFC 6265bis matching: host-only and domain cookies, path, `Secure`, `SameSite` against the request's site, expiry and `Max-Age`, the `__Host-` and `__Secure-` prefixes, and `Partitioned` (CHIPS) cookies keyed by top-level site. A vetted library such as `tough-cookie` is acceptable in the lab; record its fit and size.

**Alternative jar (J2).** Keep each container's cookies in Chrome's real jar under a prefixed name (`__rr_<container>__<name>`, written with `chrome.cookies.set`). It would make `document.cookie` emulation synchronous (filter and unprefix the real `document.cookie`), at the cost of prefixed cookies reaching the control tabs and the server in their `Cookie` header. Compare it with the extension-owned jar (J1).

### Layer 2: page APIs

A MAIN-world prelude at `document_start` in every frame (`all_frames`, `match_origin_as_fallback` for `about:blank`, `srcdoc`, and `blob:` frames) namespaces each API by container. It must know its container synchronously, before the page's first inline `<script>`. Candidate bootstraps, each measured with an inline script at the top of `<head>`:

| Bootstrap | Mechanism                                                                                                                        | Expected issue                                     |
| --------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| B1        | `Page.addScriptToEvaluateOnNewDocument` with the container id and a cookie snapshot (N2)                                         | Needs the debugger                                 |
| B2        | Static MAIN-world content script; a synchronous XHR to a same-origin marker path that a per-tab DNR rule redirects to a resource | Web-accessible resource, sync XHR, redirect limits |
| B3        | DNR appends a marker `Set-Cookie` to the tab's document response; the prelude reads it at `document_start`                       | Shared real jar: concurrent loads race             |
| B4        | `userScripts.execute` or `scripting.executeScript` with `injectImmediately` on the committing tab                                | Probably later than the first inline script        |

APIs to namespace, each with a marker test (present in its own container; absent from the other three and from the control):

- `document.cookie` and `cookieStore`.
- `localStorage`, `sessionStorage` (already per tab; test duplicated and moved tabs), and `storage` events from other containers' tabs.
- IndexedDB (`open`, `deleteDatabase`, `databases`), CacheStorage (`open`, `has`, `delete`, `keys`, `match`), and OPFS (`navigator.storage.getDirectory`).
- Cross-tab channels: `BroadcastChannel` names and Web Locks (`navigator.locks`) names; a logout broadcast must not sign out another container.
- `navigator.storage.estimate` and `persist` stay shared; record it.

Record bypasses: a prototype descriptor taken from a fresh `about:blank` iframe realm created and read synchronously, `Function.prototype.toString` checks, and frameworks that cache `window.localStorage` early.

### Layer 3: workers

- **Dedicated workers.** Content scripts do not run in workers. Test injecting the prelude by wrapping `Worker` (a `blob:` bootstrap that sets the container and then imports the original; record what breaks: `self.location`, relative `importScripts`, module workers, CSP `worker-src`) and, in N2, through auto-attach before the worker runs.
- **Shared workers.** Prefixing the `name` given to `new SharedWorker(url, name | options)` with the container gives one instance per container, shared by that container's tabs. Inside the worker, the prelude must still namespace storage, and its network requests carry `tabId: -1`, so N1 cannot attribute their cookies. Measure both; in N2, test whether `chrome.debugger` can attach to the shared worker target.
- **Service workers.** A registration is keyed by origin and scope, so two containers cannot each own one for the same scope. Test:
  - **S1, disabled in containers.** The prelude makes `navigator.serviceWorker` report no registration and reject `register`, and N2 bypasses any service worker the control registered. Measure what controls a container tab's navigation when the control already registered one.
  - **S2, one instrumented service worker** (exploratory). It namespaces caches and IndexedDB by the client's container and tags its own fetches. Expected UNDETERMINED or NO-GO; push and background sync per container are impossible either way.

### Shared caches

- **HTTP cache.** It is keyed by URL, not by the rewritten `Cookie` header, so a `Cache-Control: private, max-age=600` response without `Vary: Cookie` can serve one identity's `/me` to another container. Measure it, then the mitigations: a `Cache-Control: no-cache` request header (N1) or `Network.setCacheDisabled` (N2).
- Back/forward cache, prefetch, and prerender (speculation rules): check which `tabId` their requests carry and whether a container's state reaches another.

## Fixture

A local static server like the CDP lab's, on origins that differ from it (`http://app.localhost:4318` and an identity provider at `http://idp.localhost:4319`; `*.localhost` is loopback and a secure context, and no RECnRun build matches it). Fictional identities only. Test infrastructure, not a product backend. It needs:

- `POST /login` answering `302` with an `HttpOnly` session cookie, then `GET /me` returning the identity from that cookie (the redirect race).
- A cross-site sign-in through the identity provider by redirect and by `window.open` popup.
- A non-`HttpOnly` cookie set by the server and one set by script.
- `GET /me-cached` with `Cache-Control: private, max-age=600` and no `Vary`.
- A WebSocket whose handshake echoes the identity from its cookie.
- Same-origin, `about:blank`, and cross-site frames; a dedicated worker, a shared worker, and a service worker that each call `/me` and write storage.
- A polling endpoint for concurrency tests, and a request log that records which cookie arrived on which request, tab, and container: the ground truth for every network result.

## Phase A — Workspace and baseline

Confirm the workspace and rules, install dependencies, and record the Chromium build and OS. With no lab extension, show that the same origin in two tab groups shares everything (the problem being solved), and that two tabs in one group share storage as expected.

## Phase B — Network cookie kill test

Prove Layer 1 before writing any page virtualization. With two containers on the fixture, for N1 and N2:

- The login redirect, 50 runs per variant: the request after the `302` must carry the new session.
- Concurrent polling from both containers, 1,000 requests: no request carries the other container's cookies, per the server log.
- WebSocket handshake, same-origin and cross-site frames, the identity-provider redirect and popup.
- The real jar (`chrome.cookies.getAll` for the fixture domains) stays free of container cookies under J1; the control tab stays signed out or signed in as its own user.
- Extension service worker suspension (idle for 30 s and more) and restart in the middle of a session.

**Gate.** If neither variant isolates `HttpOnly` session cookies without a race, stop: report Layer 1 as NO-GO with the evidence and skip to the report. Storage virtualization does not matter without it.

## Phase C — Bootstrap and page APIs

Measure B1–B4 against the first inline script, pick the earliest that works for each variant, and run the Layer 2 marker matrix across four containers and the control. Record each bypass you find.

## Phase D — Workers and shared caches

Run the Layer 3 experiments (dedicated, shared, S1, S2 if time allows) and the shared-cache experiments, with the same marker method. Clean up registrations and caches after each run.

## Phase E — Four identities and lifecycle

With four groups signed in to the fixture as Admin, Requester, Approver, and Supervisor at the same time, and an ungrouped control tab:

- Admin creates a request, Requester submits it, Approver approves it, Supervisor completes it, each in its own group. The workflow state lives in the fixture server (it is the app's backend in this POC); each identity reaches it only through its own cookies.
- Lifecycle: a new tab in a group, Ctrl/Cmd-click, `window.open`, a duplicated tab, a tab dragged to another group, a closed and reopened group, a browser restart, an extension reload, and DevTools open on a container tab (N2 coexistence).
- Overhead: page-load time and request latency per variant against the control.

## Phase F — Minimal UI (only if Phase B passed)

The lab extension's own page lists groups, their containers, jar sizes, the active variant, and a leak check that compares markers across containers. Do not add it to the RECnRun dashboard, and keep it out of production builds.

## Tests, evidence, and completion

Follow red/green for every new test and behavior change: the same targeted command fails for the expected reason (for example, a leak with the lab extension off) and then passes. Broken-state experiments belong in scratch copies; remove negative controls from final code.

Cover lab logic that has rules (cookie matching, assignment state machine, API namespacing) with unit or browser-mode tests, and prove isolation with real-browser experiments: mock-only tests do not establish what Chrome does. Playwright can create and move groups through the lab extension's service worker (`chrome.tabs.group`, `chrome.tabGroups.update`); keep anything a script cannot drive (dragging a tab between groups in the UI, the debugger infobar, DevTools coexistence) in a manual checklist.

Run `vp run verify` to completion with exit code 0. Do not lower thresholds, skip coverage, bypass hooks, or loosen checks; document infrastructure blockers honestly. Add a brief entry to [POCS.md](POCS.md) linking the final report.

## Final report

Write `docs/poc-tab-group-containers-results.md` in English with:

1. Exact environment, setup, reproduction, and cleanup commands.
2. The experiment matrix: layer × mechanism × variant (N1/N2, J1/J2, B1–B4, S1/S2), each with objective, procedure, PASS/FAIL/BLOCKED/NOT TESTED, evidence (test command or artifact), and limitations. Never invent logs or mark a proposed procedure as executed.
3. The four-identity workflow, lifecycle, and overhead results.
4. A comparison with the CDP BrowserContexts POC: isolation fidelity (native versus emulated), what leaks, setup (flags, prompts), user experience (infobar, permissions), Chrome Web Store implications of `debugger` and broad host permissions (a policy assessment, not a review result), maintenance against Chrome changes, and fit with recording and replay.
5. Red/green evidence, the full verification result, and unresolved work.
6. Objective answers: four simultaneous identities on one site in one profile? Which layers isolate and which leak? Does it need `debugger`? Does it work without flags? What does a real app (OAuth redirect, service worker, shared worker) break? Recommended architecture.

Use GO (proven under the intended conditions), CONDITIONAL (proven with stated requirements, such as "N2 only" or "service workers disabled"), NO-GO (demonstrated blocker), and UNDETERMINED (untested).

## References to recheck against the tested build

- [declarativeNetRequest](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest) (`tabIds`, `modifyHeaders`, header restrictions)
- [webRequest](https://developer.chrome.com/docs/extensions/reference/api/webRequest) (`extraHeaders`, MV3 blocking)
- [chrome.debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger) and the CDP [Fetch](https://chromedevtools.github.io/devtools-protocol/tot/Fetch/) and [Network](https://chromedevtools.github.io/devtools-protocol/tot/Network/) domains
- [chrome.tabGroups](https://developer.chrome.com/docs/extensions/reference/api/tabGroups) and [content script worlds](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts)
- [RFC 6265bis](https://datatracker.ietf.org/doc/draft-ietf-httpbis-rfc6265bis/) and [CHIPS](https://developer.chrome.com/docs/privacy-sandbox/chips/)
- Firefox [contextualIdentities](https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/API/contextualIdentities), for the feature Chrome lacks

## Execution order and stopping boundaries

1. Workspace, rules, dependencies, baseline (Phase A).
2. Network cookie kill test for N1 and N2 (Phase B); stop at the gate if both fail.
3. Bootstrap and page APIs (Phase C).
4. Workers and shared caches (Phase D).
5. Four identities, lifecycle, overhead (Phase E).
6. Minimal lab UI, only if Phase B passed (Phase F).
7. All gates and the report.

Record a failed approach before trying the next. Do not merge, push, or deploy.
