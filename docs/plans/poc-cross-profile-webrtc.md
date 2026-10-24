# Plan: POC 7, cross-profile control over WebRTC

**Question.** Can one RECnRun dashboard and one PiP window control tabs in several independent Chrome profiles, with no backend, companion process, signaling server, or STUN/TURN?

**Where.** Branch `poc/cross-profile-webrtc` (no upstream), worktree `../recnrun-poc-cross-profile-webrtc`, based on `origin/master` at `b307f48`. Nothing here is merged; `master` is never pushed.

**Deliverables.** Working code in this worktree; `POC-CROSS-PROFILE-WEBRTC.md` at the worktree root (how to run, test report, architecture assessment, change summary); a POC 7 entry in [POCS.md](../POCS.md).

## 1. What exists today (from the code, not the request)

| Area             | Current state                                                                                                                                                    | Consequence for the POC                                                                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry points     | `background`, `content` (recnrun.com and localhost in dev/test), `dashboard.html`, `session.html`. No offscreen document, popup, or other page.                  | Add `offscreen.html` and `pairing.html` as WXT unlisted pages.                                                                                                                      |
| Manifest         | `storage`, `tabs`, `incognito: "spanning"`; `manifest.checks.mjs` asserts exactly that for production.                                                           | `offscreen` is added **only in development and test builds**, so the production manifest and its guard stay untouched.                                                              |
| Site ↔ dashboard | Content script frames `dashboard.html`; `recnrun-frame` postMessage channel (`route`, `location`, `open-panel`, `panel-closed`, `close-panel`).                  | Unchanged. The PiP keeps opening exactly as today.                                                                                                                                  |
| Dashboard ↔ SW   | `runtime.sendMessage` of `SessionRequestSchema` (`start-session`, `return-to-dashboard`), accepted only from extension pages (`sender.url` check).               | Remote requests follow the same pattern and the same sender check.                                                                                                                  |
| Tabs             | `tabs/open-tabs.ts`: `OpenTab`, `toBrowserTabs`, `browserTabs()` (re-reads `windows.getAll` on any tab/focus event). Nothing about tabs is stored.               | Executor reuses `toBrowserTabs` and the same event list. Remote tabs live only in memory, never in storage.                                                                         |
| REC              | `RecordingSession` (`tabId`, `status`, `banked`, `since`) in `storage.session`; one per profile. **No capture engine**: no events are recorded (M1 not started). | "Remote REC" can prove the session lifecycle (start, pause/resume, stop, focus), not recorded events.                                                                               |
| Run              | **Does not exist** (M3 in [MILESTONES.md](../MILESTONES.md)).                                                                                                    | Test F cannot pass without inventing an engine, which the request forbids. See decision D1.                                                                                         |
| Control          | `recnrun-control` Web Lock per extension origin; `controlFrom()` in `dashboard/start.tsx` takes it, posts `open-panel`, sends `start-session`.                   | The controller keeps this flow; only the last step changes for a remote tab.                                                                                                        |
| Session views    | `useRecording(store: RecordingStore)` in `views/recording.ts`; `TabList` matches `recording.tabId === tab.id`; `FloatingSession` renders the store.              | A remote-session `RecordingStore` adapter lets the dashboard and the PiP render a remote session with the existing views. Tab matching must add the profile, since tab ids collide. |
| Tests            | Playwright fixture launches one persistent context with `.output/chrome-mv3-test`; Docker + Xvfb; Vitest Browser Mode in Chromium.                               | Add a two-profile fixture (two persistent contexts, two user-data-dirs). Vitest Browser Mode can run real `RTCPeerConnection` loopback for the transport.                           |

## 2. Decisions to confirm before coding

| ID  | Decision                  | Recommendation                                                                                                                         |
| --- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Run has no engine.        | Report Test F as **not met (no Run engine exists)**; do not build a fake runner. The transport for it is the same as SESSION_START.    |
| D2  | REC has no event capture. | Test E proves the session lifecycle and that only the executor holds the session; "recording events" are reported as not applicable.   |
| D3  | Where the POC is enabled. | Development and test builds only (`offscreen` permission, pairing page, peer UI). Production build is byte-for-byte the current scope. |
| D4  | Where pairing UI lives.   | `pairing.html`, an extension page in a normal tab opened from the dashboard (manual SDP and folder). The dashboard shows peer status.  |
| D5  | `TABS_CHANGED` payload.   | Full tab list per burst of events, as `useBrowserTabs` already re-reads everything; incremental diffs are not worth it for one peer.   |
| D6  | Peer count.               | Exactly one authorized peer per profile.                                                                                               |

## 3. Architecture

```text
Profile A (controller)                                 Profile B (executor)
site tab ── dashboard frame ──┐                        ┌── pairing.html (accept)
          └ PiP: session.html │ runtime msg            │
                              ▼                        ▼
                     background SW A ◄── runtime ──► offscreen A ══ RTCDataChannel ══ offscreen B ◄── runtime ──► background SW B ── tabs/windows API B
                     (router, auth)                  (transport only)    DTLS, host ICE only               (transport only)   (router, auth, executor)
```

- **Offscreen document** (`offscreen.html`, reason `WEB_RTC`): owns the one `RTCPeerConnection` (`iceServers: []`) and its `RTCDataChannel`. It parses envelopes and checks size, forwards every inbound message to the SW, sends what the SW asks, reports link state, and keeps a diagnostics ring buffer (ICE candidates by type, gathering/ICE/connection states, errors; never message payloads). No REC/tab logic. It creates and persists its `RTCCertificate` in the extension's IndexedDB, so the DTLS fingerprint is a stable peer identity across reconnects.
- **Service worker**: `ensureOffscreen()` (checks `runtime.getContexts` before `offscreen.createDocument`); the peer router validates every message, drops anything from a non-authorized peer, and dispatches to executor handlers (local Chrome APIs) or to dashboard pages (`runtime.sendMessage` broadcast). It reuses `startSession` and `focus` from `background/session-requests.ts`.
- **Dashboard (A)**: a "Profiles" group per profile: `Chrome — Profile A (Local)`, `Chrome — Profile B (Connected | Connecting | Disconnected | Error)`, each tab keyed `profileId:tabId`. Remote tabs come from the SW on request (`GET_TABS`) and from `TABS_CHANGED` broadcasts, in memory only. Clicking a remote tab's title sends `ACTIVATE_TAB`; Record on a remote tab starts a remote session.
- **Remote session**: B is the only source of truth: its normal `RecordingSession` in its `storage.session`, plus a `session:remote-controller` marker (`{ profileId }`) so B's own dashboards say "Controlled by Profile A". A stores only a **mirror** in its `storage.session` (`session:remote-recording`: `{ profileId, displayName, session, link }`, no titles or URLs), written solely by A's SW from `SESSION_STATUS`. A `RecordingStore` adapter reads that mirror and turns `write()` into commands (pause/resume → `SESSION_SET_STATUS`, `null` → `SESSION_STOP`) without optimistic updates. `Recording` gains an optional `profileId` (absent means local), and `TabItem` matches on both.
- **One session per controller**: while A controls a remote session it offers no local Record, and vice versa, as today's single-session rule.

### New code, isolated for disposal

| Path (under `apps/extension/src`)                                                       | Role                                                                                                        |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `p2p/protocol.ts`                                                                       | Valibot schemas of the peer protocol v1 and the offscreen ↔ SW messages                                     |
| `p2p/pairing-code.ts`                                                                   | Offer/answer blob encode/decode, expiry, fingerprint extraction from SDP, short authentication string (SAS) |
| `p2p/peer-link.ts`                                                                      | Offscreen side: connection, wait-for-ICE-complete export, channel, heartbeat, diagnostics                   |
| `p2p/folder-signaling.ts`                                                               | File System Access signaling over a `FileSystemDirectoryHandle` (injected, so tests use OPFS)               |
| `background/offscreen.ts`, `background/peer-router.ts`, `background/remote-commands.ts` | Offscreen lifecycle; validation and dispatch; executor handlers                                             |
| `storage/profile-identity-repository.ts`, `storage/peer-repository.ts`                  | `local:profile-identity`, `local:authorized-peer` (`profileId`, `displayName`, `fingerprint`)               |
| `views/remote-recording.ts`, `views/use-peer-tabs.ts`                                   | Remote `RecordingStore` adapter; remote tabs hook                                                           |
| `dashboard/ProfileGroups.tsx`                                                           | The per-profile grouping around the existing `TabItem`                                                      |
| `pairing/`                                                                              | Pairing page UI and start function                                                                          |
| `entrypoints/offscreen/`, `entrypoints/pairing/`                                        | Thin wiring                                                                                                 |

Modified, minimally: `wxt.config.ts` (permission and pages per mode), `background/start.ts` (register router), `dashboard/start.tsx` (remote branch of `controlFrom`), `dashboard/TabList.tsx` (grouping, profile-aware matching), `views/recording.ts` (`profileId`), `entrypoints/{dashboard,session}/main.tsx` (pick the store), `.dependency-cruiser.cjs` (rule `extension-p2p-transport`: `p2p/` imports none of `content|dashboard|session|views|storage|background`), `docs/ARCHITECTURE.md`, `docs/POCS.md`. No new npm dependency.

## 4. Peer protocol v1

Envelope: `{ channel: "recnrun-peer", protocol: 1, id, type, from, to, ...payload }`, `id` from `crypto.randomUUID()`, `from`/`to` profile ids. Max 256 KiB per message. Responses carry `requestId`.

| Type                 | Direction             | Payload                                                 |
| -------------------- | --------------------- | ------------------------------------------------------- |
| `HELLO`              | both, on open         | `displayName`, `extensionVersion`                       |
| `PING` / `PONG`      | both                  | `timestamp` / `requestId`, `timestamp`                  |
| `GET_TABS`           | controller → executor | none                                                    |
| `TABS_SNAPSHOT`      | executor → controller | `requestId`, `tabs: RemoteTab[]`, `currentId?`          |
| `TABS_CHANGED`       | executor → controller | `tabs: RemoteTab[]`, `currentId?` (D5)                  |
| `ACTIVATE_TAB`       | controller → executor | `tabId`                                                 |
| `SESSION_START`      | controller → executor | `tabId`                                                 |
| `SESSION_SET_STATUS` | controller → executor | `status: "recording" \| "paused"` (added: pause/resume) |
| `SESSION_STOP`       | controller → executor | none                                                    |
| `GET_SESSION`        | controller → executor | none (added: resync after reconnect)                    |
| `SESSION_STATUS`     | executor → controller | `session: RecordingSession \| null`, `requestId?`       |
| `COMMAND_RESULT`     | executor → controller | `requestId`, `ok: true` or `ok: false, reason`          |
| `ERROR`              | both                  | `requestId?`, `reason` (invalid message, unauthorized)  |

`RemoteTab` = `OpenTab` minus `favicon` plus `profileId` (favicons are not sent: loading a remote URL would carry A's cookies). Not sent, ever: cookies, tokens, storage, page content, incognito tabs (an incognito tab's title and URL stay in its profile). The executor rejects a `tabId` it does not list, a second `SESSION_START` while a session runs (`busy`), and any message whose `to` is not its own profile id.

## 5. Security

- **Pairing is user-started and confirmed on both sides.** The offer carries `pairingId`, `profileId`, `displayName`, `expiresAt` (5 min), and the SDP. B shows A's name and a 6-digit SAS (SHA-256 of both DTLS fingerprints, sorted); B's user clicks Accept before an answer exists. A shows the same SAS and its user confirms before the link is authorized. DTLS then proves each side holds the key of the fingerprint the SAS covered.
- **Authorization** = the pinned `{ profileId, fingerprint }` in `local:authorized-peer`. After `HELLO`, the router closes the link if the profile id or the SDP fingerprint differs. Every command is ignored unless from the authorized peer.
- **No secrets in the shared folder**: offers and answers hold only public SDP and identity; the trust anchor is the SAS confirmation, not file presence. An unknown fingerprint arriving by folder still needs both confirmations.
- **Revoke**: "Forget this profile" in the dashboard clears `local:authorized-peer` and closes the link; B stops honoring commands at once.
- **Allowed commands only**: closed set of message types; no script execution, no URL navigation, no tab creation or closing.
- **Logs**: diagnostics record message types, sizes, states, and candidate types (host/srflx, mDNS or IP); never titles, URLs, SDP bodies, or session payloads.

## 6. Work plan

Each task is one commit with `Red:`/`Green:` lines (or `No-behavior-change:` for docs), done by the main agent or `plan-implementer`. A phase starts only after the previous one's exit check passed.

### Phase 0: setup (done)

- [x] Worktree from `origin/master` (`b307f48`), branch `poc/cross-profile-webrtc`, upstream unset so a bare `git push` cannot target `master`.
- [x] `vp install` in the worktree.
- [ ] T0.1 Baseline: `vp run verify` passes on the untouched branch (Docker running), so later failures are ours.

### Phase 1: WebRTC between two real profiles (priority 1–2)

- **T1.1** `p2p/pairing-code.ts` + `p2p/protocol.ts` (HELLO, PING, PONG, ERROR only): unit tests for round trip, expiry, oversize, invalid shapes, SAS symmetry.
- **T1.2** `p2p/peer-link.ts`: `createOffer()`/`acceptOffer()`/`acceptAnswer()` resolve only after `iceGatheringState === "complete"`; channel open/close; heartbeat (PING every 5 s, link `disconnected` after 3 missed PONGs or ICE `disconnected/failed`); invalid frames answered with `ERROR` and counted. Component test in Vitest Browser Mode with two real `RTCPeerConnection`s in one page: connects with `iceServers: []`, PING/PONG both ways, latency measured, `close()` seen as disconnect by the other side, malformed frame rejected.
- **T1.3** Offscreen entrypoint + `background/offscreen.ts` + dev/test `offscreen` permission; `pairing.html` with the manual flow (Create offer, Copy, Import offer, Accept → Generate answer, Copy, Import answer, Disconnect, state, SAS, diagnostics, Send PING with latency).
- **T1.4** `tests/e2e/fixtures/profiles.ts`: two persistent contexts with separate temp user-data-dirs, each with its own service worker. `tests/e2e/peer-link.spec.ts`: pair via the pairing pages (copying textarea values between contexts), PING/PONG in both directions, disconnect from either side is seen by the other, invalid message rejected.
- **Exit check (gate before Phase 2):** e2e green in Docker **and** a manual run on macOS with two fresh Chrome profiles (not the personal one) of the same Chrome instance, loading the unpacked dev build. If ICE fails, capture the diagnostics (candidate types, mDNS names, states) first. Fallback for tests only: launch the fixture with `--disable-features=WebRtcHideLocalIpsWithMdns` and document why; never add a STUN/TURN server.

### Phase 2: identity, authorization, full protocol

- **T2.1** `storage/profile-identity-repository.ts`: `crypto.randomUUID()` on first read, `displayName` editable on the pairing page (default "Profile A/B/C" by short id). E2e: two contexts get different ids, each stable across a service worker restart.
- **T2.2** Persistent `RTCCertificate` in IndexedDB; `storage/peer-repository.ts`; SAS confirmation on both sides; `background/peer-router.ts` with authorization and HELLO identity check. Unit tests with `fakeBrowser`: unauthorized peer's command ignored, wrong `to` rejected, identity mismatch closes the link, forget clears it.
- **T2.3** The rest of the protocol schemas (§4) with unit tests per message.

### Phase 3: shared tabs (priority 3–4)

- **T3.1** Executor: `GET_TABS` → `TABS_SNAPSHOT` from `toBrowserTabs` (incognito tabs filtered); tab/focus listeners registered at SW top level emit one `TABS_CHANGED` per burst while a peer is connected (also `windows.onRemoved`). Controller: snapshot on connect and on every reconnect.
- **T3.2** Dashboard: `ProfileGroups` with status badges, remote tabs from `views/use-peer-tabs.ts`, keys `profileId:tabId`. Component tests: grouping, status labels, no collision between equal tab ids, dashboard unchanged with no peer.
- **T3.3** `ACTIVATE_TAB`: executor validates, reuses `focus()`, replies `COMMAND_RESULT`. E2e: open and close tabs in B, see them in A's dashboard; activate a B tab from A; B's SW reports the tab active and its window `focused: true`.
- **Manual (mandatory):** on macOS, clicking a B tab in A's dashboard brings B's window to the front, with both profiles in one Chrome instance and with two separate Chrome processes (focus-stealing rules may differ).

### Phase 4: remote session and PiP (priority 5)

- **T4.1** Executor session handlers: `SESSION_START` (reuses `startSession`, writes the controller marker, rejects `busy`/unknown tab), `SESSION_SET_STATUS` (reuses `toggled`), `SESSION_STOP`, `GET_SESSION`; every change, including one made in B's own dashboard, sends `SESSION_STATUS`.
- **T4.2** Controller: mirror written only by the SW; `views/remote-recording.ts` adapter; `controlFrom()` sends `start-remote-session` for a remote tab after the unchanged `open-panel`; the PiP's `FloatingSession` renders the mirror through the adapter. `return-to-dashboard` is unchanged.
- **T4.3** Disconnect handling: on link loss the mirror keeps the last session with `link: "disconnected"`; dashboard and PiP show "Profile B disconnected: session state unknown"; the adapter rejects writes ("Profile B is not connected"); Record stays disabled so no second session starts; on reconnect `GET_SESSION` resyncs. "Forget remote session" clears only A's mirror, never B's session.
- **E2e:** start a remote session from A (PiP opens in A, B's tab active, B stores the session, A stores only the mirror); pause/resume and Stop from A's PiP reach B; Stop in B is reflected in A; closing A's PiP keeps B's session; disconnect mid-session: A shows unknown, commands rejected, B's session intact, reconnect resyncs.
- **Manual (Test G):** A's PiP stays visible on top while B's window has focus; PiP controls work while B is frontmost; Stop returns focus to A's site tab. Record what macOS does in both Chrome layouts.

### Phase 5: shared-folder signaling (priority 6)

- **T5.1** `p2p/folder-signaling.ts`: layout `<chosen>/recnrun-signaling/<profileId>/offer-<pairingId>.json` and `answer-<pairingId>.json`; atomic publish (write `*.tmp`, then `move()` to the final name; readers skip `.tmp` and unparsable files); `expiresAt` checked on read; poll every 1 s only while a pairing is pending, stop at expiry; `FileSystemObserver` only if present and shown to cut latency. Cleanup removes only this profile's own files and expired ones it wrote; never others' or anything outside `recnrun-signaling/`. Component tests on OPFS (`navigator.storage.getDirectory()`), which is a real `FileSystemDirectoryHandle`.
- **T5.2** Pairing page: "Choose folder" (`showDirectoryPicker({ mode: "readwrite" })` in the top-level extension page, never in the dashboard frame), handle kept in IndexedDB, `queryPermission`/`requestPermission` on each use; both SAS confirmations still required.
- **Manual (Test I):** same folder chosen in A and B, connection without copy and paste; revoke the folder permission (site settings) and observe; record whether the cross-origin dashboard frame can open the picker at all (expected `SecurityError`) as evidence for D4.

### Phase 6: isolation, regressions, report

- **T6.1** Test J e2e: a fixture app on a routed origin sets a cookie, `localStorage`, IndexedDB, and Cache Storage per user (`user1` in A, `user2` in B); assert each profile sees only its own, and that a test-build tap on every peer message (both directions) contains none of those values.
- **T6.2** Test K: the whole existing e2e suite passes with the POC build and no peer; production build and `vp run test:extension-manifest` unchanged.
- **T6.3** `POC-CROSS-PROFILE-WEBRTC.md` (sections 15 B–E of the request), POC 7 in [POCS.md](../POCS.md), ARCHITECTURE section; `vp run verify` exits 0.

## 7. Test matrix

| Test             | Automated (where)                                         | Manual                                | Expected outcome                       |
| ---------------- | --------------------------------------------------------- | ------------------------------------- | -------------------------------------- |
| A Two profiles   | e2e `profiles.ts`, identity spec                          | macOS, two fresh profiles             | Met                                    |
| B WebRTC P2P     | component loopback; e2e two contexts                      | macOS                                 | Met, or diagnostics if mDNS blocks ICE |
| C Shared tabs    | e2e                                                       | —                                     | Met                                    |
| D Activate tab   | e2e (B's `windows.get().focused`)                         | macOS real focus, both Chrome layouts | Met; OS focus documented               |
| E Remote REC     | e2e session lifecycle                                     | with G                                | Lifecycle met; events n/a (D2)         |
| F Remote Run     | —                                                         | —                                     | **Not met: no Run engine** (D1)        |
| G Document PiP   | e2e: PiP page in A renders B's session and sends commands | macOS visibility, focus, controls     | Documented                             |
| H Disconnect     | component + e2e (navigation and mid-session)              | macOS                                 | Met                                    |
| I Shared folder  | component on OPFS                                         | macOS picker, permission revoke       | Met or limitation documented           |
| J Data isolation | e2e                                                       | spot check in DevTools                | Met                                    |
| K Regressions    | whole existing suite, manifest guard                      | —                                     | Met                                    |

Playwright cannot run two profiles of one Chrome instance; it runs two Chromium processes with separate user-data-dirs. The one-instance layout is covered by the manual macOS runs only, and the report says so.

## 8. Risks

- **mDNS host candidates.** Without `getUserMedia` permission Chrome hides local IPs behind `*.local` names; resolution needs mDNS, which macOS has and the Docker container may not. Phase 1 measures this before anything else.
- **Offscreen lifetime.** The link dies when the extension reloads or Chrome closes the offscreen document; reconnecting needs a new offer/answer (no signaling server). The report states this as the main production gap; folder signaling can automate re-pairing.
- **Service worker sleep.** Inbound DataChannel messages reach the SW through `runtime.sendMessage`, which wakes it; listeners must be registered at top level. Covered by an e2e that stops the SW (`chrome://serviceworker-internals` is not reachable; use `serviceWorker.evaluate(() => close())` or wait out the idle timeout) mid-link.
- **macOS focus stealing.** `windows.update({ focused: true })` from a background Chrome process may not raise its window over another app; one Chrome instance is expected to behave better. Manual evidence decides.
- **Clock skew.** Elapsed time uses B's `since`; same machine is exact; across machines it would need an offset from PING/PONG (out of scope, noted).
- **Gates.** Coverage ≥ 80/75 and jscpd ≤ 4 % include the new code; Knip must see the new entrypoints (add `src/entrypoints` pages if needed).

## 9. Out of scope

Recovery of a session after the link drops (only preserved and resynced), more than two profiles, STUN/TURN, trickle ICE, Run and event capture engines, any change to the Document PiP mechanism, any production build change.
