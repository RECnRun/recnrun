# RECnRun — POC results: Tab-group containers

Plan: [poc-tab-group-containers-plan.md](poc-tab-group-containers-plan.md). Branch `poc/tab-group-containers`, based on `44c154d`. The lab is the unpacked MV3 extension and Node harnesses under `scripts/containers-lab/`; nothing under `apps/` or `packages/` changed, and the production manifest guard still passes.

**Verdict: CONDITIONAL.** Four identities on one site in one ordinary Chrome profile work with variant **N2B1** (`chrome.debugger` per container tab plus the B1 page prelude), with service workers disabled in containers (S1), the HTTP cache bypassed on the app's hosts, and two known leaks: a shared worker's network requests carry the profile's own cookies, and requests made while the extension reloads carry them too. Without the debugger (N1), cookies isolate but the login redirect races and the page cannot be bootstrapped before its first script.

## 1. Environment, setup, reproduction, cleanup

| Item     | Value                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------ |
| OS       | macOS 27.0.1 (26A434), arm64                                                                           |
| Browser  | Playwright Chromium 156.0.8078.4 (`channel: "chromium"`, headless, temporary profile, no extra flags)  |
| Node     | v22.22.2                                                                                               |
| Fixture  | `http://app.localhost:4318` (app) and `http://idp.localhost:4319` (identity provider), fictional users |
| Variants | `off`, `N1` (DNR + webRequest), `N1r` (N1 that reloads a stale navigation), `N2`, `N2B1`               |

```sh
vp install
vp run test:containers-lab                              # unit checks: jar matching, DNR rules (node --test)
node scripts/containers-lab/network.mjs off N1 N1r N2   # Phase B
node scripts/containers-lab/bootstrap.mjs               # Phase C: B1, B2, B4
node scripts/containers-lab/pageapis.mjs off N2 N2B1    # Phase C: API matrix
node scripts/containers-lab/workers.mjs N2B1            # Phase D
node scripts/containers-lab/lifecycle.mjs               # Phase E: lifecycle cases (each case can be named)
node scripts/containers-lab/workflow.mjs                # Phase E: workflow and overhead
```

Each harness starts the fixture, launches Chromium with the lab extension in a `mkdtemp` profile, writes `.artifacts/containers-lab/<name>.json`, and deletes the profile on close. Cleanup: `vp run clean` removes `.artifacts/`; nothing else persists. Run one harness at a time: they share the fixture ports.

## 2. Experiment matrix

| Layer        | Mechanism                                        | Variant | Result          | Evidence                                                                                                                                                                                                                                   | Limitations                                                                                                                                               |
| ------------ | ------------------------------------------------ | ------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline     | No isolation                                     | off     | FAIL (expected) | `network-off.json`: 1000/1000 polls wrong; every tab ends as the last user to sign in                                                                                                                                                      | The problem being solved                                                                                                                                  |
| Network      | DNR `Cookie`/`Set-Cookie` rules + webRequest     | N1      | FAIL            | `network-N1.json`: the page lags one sign-in state behind in 50/50 runs × 2 (still signed in after logout 49/50, signed out after login 50/50); IdP redirect lands signed out; concurrency 0/1000 wrong, WebSocket and popup (10/10) right | Rules update after the `302`; the next request leaves with the old jar                                                                                    |
| Network      | N1 + reload of stale navigations                 | N1r     | FAIL            | `network-N1r.json`: login right in 17/50 runs × 2; popup 8/10; concurrency 0/1000 wrong                                                                                                                                                    | Still racy; a reload is visible to the app                                                                                                                |
| Network      | `chrome.debugger` Fetch writes `Cookie`          | N2      | PASS            | `network-N2.json`: redirect 50/50 ×2, 0/1000 wrong, WebSocket, IdP redirect and popup (10/10, 0 leaks), frames; real jar holds only the control's `sid`                                                                                    | WebSocket handshakes keep a DNR rule (Fetch does not see them); cross-site frames are signed out, as `SameSite=Lax` requires                              |
| Network      | `webRequestBlocking` (N3)                        | —       | NOT TESTED      | —                                                                                                                                                                                                                                          | MV3 limits it to policy-installed extensions; not a Web Store path                                                                                        |
| Jar          | Extension-owned jar in `storage.local` (J1)      | N1, N2  | PASS            | `jar.checks.mjs`, `dnr-rules.checks.mjs` (20 checks); network runs above                                                                                                                                                                   | Hand-written RFC 6265bis subset (host-only/domain, path, Secure, SameSite, expiry, prefixes); `Partitioned` not exercised against a real cross-site embed |
| Jar          | Prefixed cookies in Chrome's jar (J2)            | —       | NOT TESTED      | —                                                                                                                                                                                                                                          | Leaks prefixed cookies to the control and the server by design                                                                                            |
| Bootstrap    | B1 `Page.addScriptToEvaluateOnNewDocument`       | N2      | PASS            | `bootstrap.json`: before the first inline script in 20/20 loads × 4 containers                                                                                                                                                             | Needs the debugger                                                                                                                                        |
| Bootstrap    | B2 sync XHR to a DNR-redirected marker           | N1, N2  | PASS            | `bootstrap.json`: 20/20 × 4, median 3.3–3.5 ms (max 15.7 ms); control gets `null`                                                                                                                                                          | A synchronous XHR on every document and frame                                                                                                             |
| Bootstrap    | B3 marker `Set-Cookie`                           | —       | NOT TESTED      | —                                                                                                                                                                                                                                          | B1 and B2 already passed                                                                                                                                  |
| Bootstrap    | B4 `scripting.executeScript` `injectImmediately` | N2      | FAIL            | `bootstrap.json`: 0/20 before the first inline script                                                                                                                                                                                      | Too late, as expected                                                                                                                                     |
| Page APIs    | Prelude namespaces storage and channels          | N2B1    | PASS            | `pageapis-N2B1.json`: 6 tabs × `localStorage`, `sessionStorage`, `document.cookie`, IndexedDB, CacheStorage, OPFS, no leak, also after reload; BroadcastChannel and `storage` events reach only Admin and Admin2; locks per container      | `cookieStore` is removed in containers; `navigator.storage.estimate`/`persist` stay shared                                                                |
| Page APIs    | No prelude                                       | off, N2 | FAIL (expected) | `pageapis-off.json`, `pageapis-N2.json`: every container reads the control's storage                                                                                                                                                       | Shows Layer 2 is required even with N2                                                                                                                    |
| Page APIs    | Bypass: fresh `about:blank` realm                | N2B1    | PASS            | `pageapis-N2B1.json` `bypass.freshRealm`: the new realm is patched too (`native: false`)                                                                                                                                                   | Hostile script can still find other escapes; not a security boundary                                                                                      |
| Workers      | Dedicated and module workers (auto-attach + B1)  | N2B1    | PASS            | `workers-N2B1.json`: 0 wrong, one instance per tab                                                                                                                                                                                         | —                                                                                                                                                         |
| Workers      | Shared worker, name prefixed per container       | N2B1    | FAIL (partial)  | `workers-N2B1.json`: one instance per container and storage isolated, but `/me` from the worker is Control in all 5 containers                                                                                                             | Fetch never pauses a shared worker's requests and extra headers do not reach them, so its network uses Chrome's jar                                       |
| Workers      | Service workers disabled in containers (S1)      | N2B1    | PASS            | `workers-N2B1.json`: container navigations come from the network, the control's from its worker; `register` in a container rejects with `SecurityError`                                                                                    | Apps that need a service worker (offline, push) lose it in containers                                                                                     |
| Workers      | One instrumented service worker (S2)             | —       | NOT TESTED      | —                                                                                                                                                                                                                                          | Exploratory; push and sync per container are impossible regardless                                                                                        |
| Shared cache | HTTP cache keyed by URL                          | N2B1    | PASS after fix  | `workers-N2B1.json` `cache`: Admin, Requester, Control each get their own `/me-cached`, 3 server hits                                                                                                                                      | Cost: no cache reads on the matched hosts (see §5)                                                                                                        |
| Shared cache | bfcache, prefetch, prerender                     | —       | NOT TESTED      | —                                                                                                                                                                                                                                          | —                                                                                                                                                         |

## 3. Four identities, lifecycle, overhead

**Workflow** (`workflow-*.json`): Admin creates, Requester submits, Approver approves, Supervisor completes, 20 requests in parallel per step, plus a control tab signed in as Control.

| Variant | Signed in                         | Steps (create/submit/approve/complete) | Wrong histories | Out-of-turn steps |
| ------- | --------------------------------- | -------------------------------------- | --------------- | ----------------- |
| off     | everyone ends as the last sign-in | 0/0/0/0                                | 20              | —                 |
| N1      | first render signed out           | 20/20/20/20                            | 0               | refused           |
| N2      | each its own user                 | 20/20/20/20                            | 0               | refused           |
| N2B1    | each its own user                 | 20/20/20/20                            | 0               | refused           |

**Lifecycle** (`lifecycle.json`, N2B1, Admin and Control signed in):

| Case                                       | Result     | Observation                                                                                                                                      |
| ------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ctrl/Cmd-click a link                      | PASS       | Opens in the Admin group; first render signed out, then the extension reloads it as Admin; never Control                                         |
| Duplicate tab                              | PASS       | Same as Ctrl-click                                                                                                                               |
| Move a loaded tab to another group         | PASS       | Reloaded automatically; signed out with Requester's (empty) storage                                                                              |
| Close and restore (`chrome.sessions`)      | PASS       | Restored into a new group titled "Admin" and mapped back to the Admin container                                                                  |
| Extension service worker stopped           | PASS       | CDP `ServiceWorker.stopAllWorkers`: 3850/3850 requests as Admin while it restarted; the debugger session survives and is adopted                 |
| Extension reload                           | FAIL       | 52–64 of ~3600 requests carried Control and some failed while the extension was unloaded; Admin afterwards. Needs developer mode in Chromium 156 |
| Browser restart (`--restore-last-session`) | PASS       | Group titles survive; Admin and Control correct. The jar keeps session cookies across a restart, as session restore does                         |
| Idle 30 s suspension                       | NOT TESTED | Playwright's CDP connection keeps the extension's worker alive; the forced stop above stands in for it                                           |
| DevTools open on a container tab           | NOT TESTED | Playwright is itself a second CDP client and coexists; a real DevTools window is a manual check                                                  |
| Debugger infobar                           | NOT TESTED | Headless shows no infobar; Chrome documents "… started debugging this browser" for `chrome.debugger.attach`                                      |

**Overhead** (`workflow-*.json`, Admin tab, 100 fetches and 20 loads):

| Variant  | `fetch` median | Page-load median |
| -------- | -------------- | ---------------- |
| off, N1  | 0.7 ms         | 4.0 ms           |
| N2, N2B1 | 1.2 ms         | 4.7–5.0 ms       |

## 4. Comparison with the CDP BrowserContexts POC

The `poc/chrome-cdp-browser-contexts` branch and its worktree are not in this repository, so this compares designs, not measured results.

| Aspect               | CDP BrowserContexts                                                          | Tab-group containers (N2B1)                                                                                                                                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Isolation fidelity   | Native: Chrome keeps a separate jar, storage, cache, and workers per context | Emulated: rewritten `Cookie` headers and a page prelude                                                                                                                                                                                           |
| What leaks           | Only what a context shares by design                                         | Shared-worker network, the extension-reload window, `storage.estimate`, and the out-of-scope list below; hostile page script can escape                                                                                                           |
| Setup                | A Chrome launched with remote debugging                                      | An ordinary profile; no flags                                                                                                                                                                                                                     |
| User experience      | A separate, driven browser window                                            | The user's own tab groups; the debugger infobar on every attached tab; a reload when a tab joins or changes group                                                                                                                                 |
| Permissions and CWS  | Outside the Web Store                                                        | `debugger` (warning: access to the page debugger backend), `tabs`, `tabGroups`, `webRequest`, DNR, and host access. `debugger` makes Web Store review stricter and needs a clear single purpose; this is a policy assessment, not a review result |
| Maintenance          | Stable CDP surface                                                           | Many Chrome behaviors at once: DNR header rules, Fetch on workers, cache keys, prelude coverage of new storage APIs                                                                                                                               |
| Recording and replay | Contexts suit automated replay                                               | A RECnRun recording that uses the debugger must share the containers' session: one extension cannot attach to a tab twice                                                                                                                         |

## 4b. Comparison with the cross-profile WebRTC POC

[PR #13](https://github.com/RECnRun/recnrun/pull/13) (`poc/cross-profile-webrtc-v2`) keeps each identity in its own Chrome profile and lets one profile's dashboard and PiP window list, activate, and record the other profile's tabs over a WebRTC DataChannel between offscreen documents. This compares its report with the results above; its branch was not run here.

| Aspect               | Profiles over WebRTC                                                                   | Tab-group containers (N2B1)                                                              |
| -------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Isolation            | Native per profile: cookies, storage, HTTP cache, every worker, passwords, permissions | Emulated; shared-worker network and the extension-reload window leak                     |
| Service workers      | Work                                                                                   | Disabled in containers                                                                   |
| Permissions          | `offscreen`                                                                            | `debugger`, with its install warning and its infobar on every container tab              |
| Setup                | One profile per identity, the extension in each, pairing by code or shared folder      | Name a tab group                                                                         |
| After a restart      | Pair again                                                                             | Groups map back to their containers by title                                             |
| Identities tested    | Two profiles, one peer                                                                 | Four containers and the control                                                          |
| Recording and replay | Each profile records its own tabs                                                      | A debugger-based recording must share the containers' session                            |
| Maintenance          | A small peer protocol over stable APIs                                                 | Many Chrome behaviors at once (DNR, Fetch on workers, cache keys, every new storage API) |

Containers are the more convenient of the two; profiles are the more correct. A tool that records and replays sessions cannot afford a silent identity leak, so profiles are the better base, and reconnecting without a new pairing is cheaper to solve than the containers' leaks.

## 5. Red/green evidence and verification

- **HTTP cache.** Red: `dnr-rules.checks.mjs` "no tab reads the shared HTTP cache…" failed; the browser run served Control's tab "Requester" from the cache (2 server hits for 3 tabs). Green: the `BYPASS_CACHE` rule (`cache-control: no-cache` on every request to the matched hosts); the check passes (9/9) and each tab gets its own user (3 hits). A response `cache-control: no-store` was tried first and had no effect.
- **Ctrl-click and duplicate.** Red: the new tab rendered "Control", because it was classified before the debugger attached. Green: `sync()` attaches the debugger first and only then classifies the tab; it renders signed out, then Admin.
- **Move to another group.** Red: no reload and `localStorage` "Admin", because the tab passes through an untitled group. Green: untitled groups stay unclassified, and a tab that changes class is reloaded.
- **Service worker stop.** Red: the first request after the stop carried Control, then "Another debugger is already attached to the tab with id: …". Green: the restarted worker adopts the session and holds paused requests until it has classified the tabs; 3850/3850 as Admin.
- **Popup sign-in.** Mid-session regressions (0/10, then 4/10) went back to 10/10 with the jar storing early `Set-Cookie` once the tab's container is known.
- **Gates.** `vp check`, `vp run deps`, Knip, and jscpd pass; `vp run test:containers-lab` passes 20/20 and is part of `verify:local`. `vp run verify` exits 0 in Docker (23/23 tasks: 151 unit and component tests, 42 end-to-end tests, coverage, no clones, production manifest guard 6/6).

## 6. Answers

- **Four simultaneous identities on one site in one profile?** Yes, with N2B1: the workflow ran 20/20 per step with 0 wrong histories.
- **Which layers isolate and which leak?** Isolated: HTTP cookies (N2), WebSockets, redirects and popups, every page storage API, BroadcastChannel and locks, dedicated and module workers, the HTTP cache (after the bypass). Leaking: shared-worker network, requests during an extension reload, `storage.estimate`/`persist`, and the out-of-scope items. Disabled: service workers and `cookieStore` in containers.
- **Does it need `debugger`?** Yes. Without it the login redirect races (N1) and the prelude cannot know its container before the page's first script except through B2's synchronous XHR.
- **Does it work without flags?** Yes, in Playwright's Chromium with a temporary profile. Branded Chrome needs a manual load from `chrome://extensions`; not done.
- **What does a real app break?** A service-worker app loses its worker in containers; a shared worker that calls the API acts as the profile's user; every first load of a new or moved tab is followed by a reload; the HTTP cache is off on the app's hosts.
- **Recommended architecture.** If containers become a product feature, use N2B1 with S1 and the cache bypass, attach only to tabs in container groups, and keep the control tabs untouched. Keep the cookie jar and the rule builder as tested domain logic, and record the shared-worker and reload leaks in the product rules. For RECnRun, prefer separate Chrome profiles linked over WebRTC (§4b): their isolation is native, and the leaks above would corrupt a recording silently.

**Shared across containers (out of scope):** IP and fingerprint, the HTTP authentication cache, TLS client certificates, HSTS, the password manager and autofill, site permission grants, FedCM, WebAuthn credentials, and storage quota (`navigator.storage.estimate`).

## Unresolved

- Phase F (the lab's own UI page) was not built.
- Manual checks: the debugger infobar, DevTools on a container tab, dragging a tab between groups by hand, idle suspension, and a load in branded Chrome.
- J2, N3, B3, S2, bfcache, prefetch, prerender, and `Partitioned` cookies across sites.
- A way to give shared workers their container's cookies, and to cover the extension-reload window.
