# RECnRun — POC plan: pair once, then stay out of the way

## Objective

The manual run on 2026-10-25 (two profiles of one branded Chrome on macOS) proved the POC works: manual pairing, folder pairing, ping, Show tab, and the PiP controlling the other profile's session. It also showed the flow is too busy for a user to see any benefit. Pairing takes about ten clicks spread over two windows ("go to this profile, now the other one, now back"). A disconnect shows "Error". A dead link leaves stale tabs and live buttons, and Record works in both dashboards at once, which upsets the PiP.

Target experience:

1. In profile A: **Pair** → choose the folder → Chrome's "Allow this site to edit files?" → **Allow**. Done.
2. In profile B: **Pair** → the same folder → **Allow**. Done.
3. From then on, the two profiles find each other, connect, and reconnect after a restart or a dropped link with no user action. Everything else is invisible.

This plan supersedes `docs/poc-cross-profile-reconnect-plan.md`: its hypotheses H1–H4 and its reconnect design become phase 3 below. Delete that file when this plan is committed.

Branch `poc/cross-profile-webrtc-v2` (PR #13), this worktree. Do not create another one. Ask before pushing (a push updates PR #13), never push to `master`, and do not merge.

## Findings from the manual run

| #   | Observed                                                                                                                                                             | Likely cause (to confirm)                                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Pairing, manual or through the folder, takes about ten steps across both profiles: choose folder, publish, find, import, accept, copy, confirm                       | The folder only carries the codes; every manual step stayed                                                                                                                                                                                               |
| F2  | After **Disconnect** in one profile, the other shows "Chrome — Profile B (Error)"                                                                                    | Nothing tells the peer the close was intended. Its ICE state becomes `failed`, which `PeerProfiles.tsx` labels "Error"                                                                                                                                    |
| F3  | With the link down, A still lists B's tabs with **Continue**, **Stop**, and **Show tab** enabled                                                                     | The remote list renders the last report whatever the link state                                                                                                                                                                                           |
| F4  | A minute later, A shows B's session as "Closed tab — The tab this session records was closed. Recording 04:41", while B shows no recording; the PiP becomes unstable | The tabs cache in `background/peers.ts` lives only in the service worker's memory. When the worker sleeps or the link goes down, the tab list empties, so the mirrored session looks orphaned. The mirror is not marked stale, so the clock keeps running |
| F5  | **Record** is enabled in both dashboards, for local and remote tabs, while a session runs; clicking it upsets the PiP                                                | The control lock (`CONTROL_LOCK`, Web Locks) is per profile. Two profiles of one Chrome share one browser process, and Chrome keeps one Document PiP window per browser, so each profile's PiP replaces the other's (to confirm, H5)                      |
| F6  | The dashboards list RECnRun's own `pairing.html` tabs (twice) and `chrome://` tabs, with **Record**                                                                  | The tab list has no filter for pages that cannot be recorded. The `chrome://` part also happens on `master`, so it is out of scope here except for the extension's own pages                                                                              |
| F7  | The PiP itself, Show tab, and ping work                                                                                                                              | —                                                                                                                                                                                                                                                         |

## Decision: the folder is the consent (option (a), no mitigations)

The POC brief requires explicit acceptance on both sides and forbids silently accepting an unknown peer. On 2026-10-25 the user chose to drop that rule for folder pairing. Choosing the same folder in both profiles is the explicit act, and the first other profile found there is paired, with no digit check, no time window, no single-candidate rule, and no Undo. **Forget the other profile** stays the way out.

Recorded risk: whoever can write to the folder and reach this machine over the local network can pair first. That includes another Mac syncing the folder through iCloud or Dropbox, another user with access to the folder, or an app given that folder. A paired peer receives the titles and URLs of all open tabs, can bring a tab to the front, and can start and stop sessions. Once capture and Run cross the link, it would also receive recorded events and drive the browser. Revisit this decision then. Malware running as the same user is not a new risk: it can already read the Chrome profile.

Reconnecting to the pinned peer needs no click (phase 3), and its fingerprint proves who it is.

## Hypotheses to measure first

Record each as PASS, FAIL, BLOCKED, or NOT TESTED, with the Chromium build, before designing around it. The manual ones need the user; prepare the steps, ask, and wait for the answer.

| Id  | Hypothesis                                                                                                                                                           | How                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| H1  | A `FileSystemDirectoryHandle` stored in IndexedDB keeps `readwrite` permission after a browser restart for the `chrome-extension://` origin ("Allow on every visit") | Manual, in branded Chrome with a disposable profile                                                          |
| H2  | The offscreen document can read the stored handle and poll the folder, so no visible page is needed after pairing                                                    | Automated where possible; otherwise a manual check with logs                                                 |
| H3  | When permission falls back to `prompt`, `requestPermission` works after one click in `pairing.html`, and fails in the dashboard framed on the site                   | Manual; record the exact errors                                                                              |
| H4  | Playwright can drive `showDirectoryPicker`                                                                                                                           | One try. If not, e2e tests use the injected rendezvous port below                                            |
| H5  | Two profiles of one Chrome share one Document PiP window: opening the PiP in B closes A's                                                                            | Manual, with two profiles of one branded Chrome (two `launchPersistentContext` calls are separate processes) |
| H6  | In branded Chrome on macOS, the picker lets the user create and choose `~/RECnRun`; the home folder itself is refused                                                | Manual; record the picker steps and any error text                                                           |

Results so far:

- **H4: FAIL** (2026-10-26, Playwright's Chromium 156.0.8078.4 in Docker, one try). `showDirectoryPicker` in `pairing.html` rejects at once with `AbortError: Failed to execute 'showDirectoryPicker' on 'Window': Intercepted by Page.setInterceptFileChooserDialog().`, and no `filechooser` event fires. The e2e tests use the injected rendezvous port.
- **H5: PASS** (2026-10-26, Google Chrome 156.0.8078.47 (arm64) on macOS 27.0.1, two profiles of one user data directory). Each profile records its own session in its own PiP window, but Chrome shows one at a time: opening B's PiP closes A's, and A's dashboard falls back to Continue and Stop, as for a session with no controller. Both sessions keep running.

If H1 fails, reconnection after a restart costs one click ("Reconnect to <name>"), not zero. If H2 fails, polling needs a page (the pinned dashboard or an `pairing.html` tab), which is worse. Report it plainly.

## Phase 1 — Link-down states and one session across the pair (F2–F6)

These bugs exist with today's manual pairing, so fix them first. They are small and each gets a red/green test.

1. **Intended close.** Add a `BYE` message (protocol 1 gains a type, so update its schema and tests). **Disconnect** and **Forget** send it before closing. The peer then records `closed by peer`, not `failed`.
   - Labels: "Disconnected by <name>" for a close the user asked for. "Reconnecting…" while phase 3 retries. "Not reachable" once retries give up. "Error" stays only for a certificate mismatch.
2. **Stale remote view.**
   - While the link is not `connected`, the remote section keeps the last tab list read only, greyed, with no buttons, under "<name> — Reconnecting…".
   - Persist the tabs cache in `storage.session`, next to the mirror, so a sleeping service worker does not empty it.
   - While the link is down, a mirrored session shows "Link lost — last seen recording at 04:41". The clock stops, and the session is never shown as "Closed tab".
3. **One controller for the pair.**
   - The executor's `SESSION_STATUS` already tells the other profile when a session runs. Use it as a lock shared across the link: while either profile has a session, local or controlled, every **Record** in both dashboards is disabled, with "Recording in <name>".
   - A **Record** click that loses the race gets `COMMAND_RESULT` refused and opens no PiP.
   - Confirm H5 first. If the PiP is shared across the browser, this rule is required. If not, it is still the right product rule.
4. **Own pages.** Leave the extension's own pages (`chrome-extension://<own id>/`) out of both the local and the shared tab lists.

Tests:

- Unit: the BYE handling, the label map, the cross-link lock, and the own-page filter.
- Browser Mode: the remote section in each link state, and a mirrored session while the link is down.
- E2E: a new case in `cross-profile-link.spec.ts`. A disconnects; B shows "Disconnected by Profile A" (red today: "Error"). Extend the session spec too: while B records, Record is disabled in both dashboards.

## Phase 2 — Pairing by choosing a folder (F1)

1. **One button.**
   - The pairing page opens on **Pair with another profile**. That button calls `showDirectoryPicker({ id: "recnrun-pairing", mode: "readwrite", startIn: "documents" })`, then Chrome's "Allow this site to edit files?" prompt.
   - The handle is stored in IndexedDB beside the certificate.
   - The manual code flow moves under "Pair by hand instead" as the fallback.
   - **The default folder is `~/RECnRun`, as close as a browser allows.** An extension cannot create a folder or preselect a path without the picker, and `startIn` accepts only well-known folders (`documents`, `downloads`, `desktop`, and so on) or an existing handle, not the home folder. Chrome blocks choosing the home folder itself, but allows folders inside it. So the page says "Choose or create the RECnRun folder in your home folder". The picker opens in Documents, where the user goes up one level and uses New Folder; the second profile picks the same folder.
   - Measure H6 before building this. Alternatives, if the picker steps are too many: start in Documents and suggest `Documents/RECnRun` (Documents may sync through iCloud, see the risk above). Or create `~/Downloads/RECnRun` first with `chrome.downloads`, so the folder already exists in the picker. That costs the `downloads` permission ("Manage your downloads") and a visible download, so prefer the home folder unless H6 shows it is clumsy.
2. **Presence, not buttons.** Each profile writes `recnrun-signaling/<profileId>/presence.json` atomically, with its `displayName`, its fingerprint, and an expiry. It refreshes the file while it waits.
3. **Who offers.** When both presences are in the folder, the profile with the lower `profileId` writes the offer, and the other answers. This replaces **Publish offer** and **Find an offer**.
4. **Acceptance** follows the decision above: no click. Each profile pairs with the first other presence it finds, the oldest by `createdAt`, and ignores the rest once a peer is pinned. The offerer still accepts only an answer to its own pending offer, and `linkUp` still checks the DTLS fingerprint against the one in that answer.
5. **Polling** runs from the moment a folder is chosen until a peer is pinned, in the offscreen document (H2), so the pairing tab can close. It stops on success or on **Forget**. Clean up only the profile's own files, as today.
6. **The dashboard entry.** "Pair another profile" in the dashboard opens `pairing.html` in a tab, because the framed dashboard cannot show the picker. When pairing succeeds, the tab says "Paired with <name>", and the dashboard updates on its own.

Tests:

- Unit: the presence schema, the offer-role choice, and the acceptance rule. The rule picks the oldest other presence and rejects its own presence, an expired presence, a malformed file, and an answer whose fingerprint differs from the SDP's.
- Browser Mode: two `folderSignaling` instances over one OPFS directory pair with no click.
- E2E: a rendezvous port injected by the test build stands in for the picker, unless H4 passes. Each profile gets only **Pair**, and both reach `Connected`. Say plainly in the report that the native picker was not driven.

## Phase 3 — Reconnect without the user (from the reconnect plan)

1. **The rendezvous port** has `publish`, `find`, and `clean`. The stored folder handle implements it, and so does the test adapter.
2. **Reconnect codes** use a new kind, `reconnect-offer` and `reconnect-answer`, with the pairing envelope, a 60 s expiry, and a fresh `pairingId` per attempt.
3. **Auto-accept** happens only when the code's `profileId` is the pinned peer's and the fingerprint in its SDP is the pinned one (`fingerprintOf`). `linkUp` still checks the DTLS-proven fingerprint. Anything else is ignored and logged without its contents.
4. **When to reconnect.**
   - Attempts start at extension start when a peer is pinned, and on a link that drops without a `BYE`.
   - The lower `profileId` offers.
   - Backoff: 1 s, 2 s, 5 s, then every 10 s, polling only while disconnected.
   - A `BYE` or **Forget** stops attempts. After **Disconnect**, the peer stays pinned with reconnect off until the user clicks **Connect**.
5. **Fallback.** When H1 fails or permission returns to `prompt`, the dashboard shows "Reconnect to <name>". That button opens `pairing.html`, which calls `requestPermission`; nothing else changes.
6. **Builds.** Everything stays behind `peersEnabled`, and the production manifest guard must keep passing.

Tests:

- Unit: the reconnect code schema, the auto-accept rule (wrong id, wrong fingerprint, expired, pairing-kind code), the backoff schedule, and that **Forget** removes the handle and stops attempts.
- E2E: pair, close B, relaunch it with `launch(dir)`. With no user action the link reaches `connected`, ping works, and A lists B's tabs again.
- Negative e2e: a third profile's reconnect offer is ignored, or `linkUp` closes its link. No command crosses.

Optional, measured only after the rest passes, and never shipped: derive `ice-ufrag` and `ice-pwd` from a secret agreed at pairing, so a reconnect signal is just `ip:port` (SDP munging, as in libp2p WebRTC-direct).

## Out of scope

- A server or relay, native messaging, `chrome.storage.sync`, and the clipboard as a channel.
- `chrome.downloads` with "Allow access to file URLs" as a pickerless folder: it needs a manual toggle in `chrome://extensions`, which is worse than the picker.
- More than one peer, and two machines across NAT.
- Mention these in the report only as alternatives.

## Manual checks for the user (after each phase)

- **Phase 1:** Disconnect in A → B shows "Disconnected by A", with no "Error". Record in B → Record is disabled in A. Close B while recording → A shows "Link lost", not "Closed tab".
- **Phase 2:** in each profile, **Pair**, the `~/RECnRun` folder, **Allow**. Close the pairing tab in A before pairing B. Count the clicks.
- **Phase 3:** quit B and reopen it, and see that it reconnects alone. Then H1 and H3, and revoking the folder permission.

## Done

- Each phase is one or more commits with `Red:`/`Green:` lines, and `vp run verify` exits 0 at the end of each phase.
- Update `POC-CROSS-PROFILE-WEBRTC.md`: the findings table above, H1–H5, the clicks needed per case (fresh pair, restart with permission kept, restart with permission prompt), and the "Before production" list. Also update `docs/POCS.md` and the Cross-profile section of `docs/ARCHITECTURE.md`.
- The final report, in Portuguese, ends with what was exercised and the result, and names what was not exercised and why. Ask before pushing.
