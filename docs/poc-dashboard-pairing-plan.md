# Plan: pairing from the dashboard alone

Branch `poc/dashboard-only-pairing`, stacked on `poc/cross-profile-webrtc-v2` (PR #13). It carries out the "Next phase" of `docs/poc-cross-profile-usability-plan.md`, decided on 2026-10-26.

## Goal

In each Chrome profile the user clicks the dashboard's button to set up the RECnRun folder, and pairing completes with nothing else to do. After a disconnect, the dashboard offers the same step again. `pairing.html` goes away. What stays is the smallest top-level extension window Chrome needs for its picker and prompts (H2): it grants the folder, waits until the profiles pair, and closes itself.

## Decisions

- **The manual code flow goes.** The page requests `create-offer`, `inspect`, and `accept`, the six-digit check, and the `PairingPreview` result are removed. Folder pairing keeps the offer and answer codes it writes to the folder, and `linkUp`'s certificate check.
- **Ping and diagnostics go** (the user's choice). `Send ping` and `Show diagnostics` existed only on the pairing page. Their requests, and protocol messages or link commands no one else uses, are removed. Test B proves the link with the other profile's tabs in each dashboard and the frames each background exchanged.
- **The dashboard gains a "Pairing" section** under the tab lists, replacing "Manage pairing": the profile's name with **Save name**, the link in words (the pairing page's status line), the existing **Pair with another profile** or **Reconnect** step, **Disconnect** while connected, and **Forget <name>** while a peer is pinned.
- **The folder window is the only extension page left.** It opens from the banner, as today; `pairing.html` without `#folder` no longer exists. Renaming the entrypoint to `folder.html` and `src/pairing` to `src/folder` is the last task, with `.dependency-cruiser.cjs` and `docs/ARCHITECTURE.md`.
- **Every end-to-end test pairs through the real folder**, driven by `native-dialogs.ts`, since the picker is never mocked. The profiles fixture opens each profile's site tab and names the profile in its dashboard, and `pair(a, b)` chooses the folder in each through the window.

## More than two profiles (later phases)

Later phases pair more than two profiles at once, such as the default profile and profiles A, B, and C (the user's requirement, 2026-10-27). This POC still links one peer, but its changes must not make that harder. The target design:

- **Authorized peers are a list**, replacing the one `AuthorizedPeer` in storage. Each entry keeps its profileId, name, and pinned certificate fingerprint.
- **One link per peer.** The offscreen document holds one `RTCPeerConnection` per peer (a mesh), each with its own state.
- **Folder pairing pairs with every presence** in the folder, instead of ignoring the rest once a peer is pinned. In each pair, the profile with the lower profileId writes the offer.
- **The dashboard lists each peer's tabs**, grouped by profile name, and the link status shows one line per peer.
- **Commands name their peer.** Tab commands and frames carry the target profileId.
- **The session lock spans all peers**, so one recording session drives tabs in any of them.
- **Disconnect and Forget act per peer.**

## Tasks

1. **Dashboard pairing section.** Component tests first (name, status words, Disconnect, Forget, the step), then the section. Additive: the pairing page still works.
2. **End-to-end tests through the dashboard.** The fixture and `cross-profile-{link,tabs,isolation}.spec.ts` and `folder-pairing.spec.ts` stop using the pairing page. Tests only, while the page still exists.
3. **Remove the pairing page and the manual flow.** `PairingPage.tsx`, `PairingSteps.tsx`, `FolderSection.tsx`, `openPairing`, the manual requests, ping, diagnostics, and their tests. `startPairing` renders only the folder window.
4. **Rename** `pairing` to `folder` (entrypoint, source folder, dependency rules, manifest guard).
5. **Docs.** `POC-CROSS-PROFILE-WEBRTC.md` (tests B and K, the clicks per case, "Before production"), `docs/POCS.md`, `docs/ARCHITECTURE.md`, `.claude/rules/extension.md`, and this plan's results.

Each task is one commit with `Red:` and `Green:` lines where behavior changes, and `vp run verify` exits 0 at the end.

## Results (2026-10-27)

All five tasks are done, and `vp run verify` exits 0 on the branch:

- The dashboard's **Pairing** section holds the profile's name, the link in words, **Pair with another profile** or **Reconnect**, **Disconnect**, and **Forget <name>**.
- Every end-to-end test pairs through the real folder, from the dashboards, with Chrome's picker and prompts driven by `xdotool`.
- The pairing page, the manual code flow, ping, and diagnostics are gone; the folder window is `folder.html` from `src/folder`.
- Test B now proves the link by each dashboard listing the other profile's tab and by the frames each background exchanged.
- Found on the way and fixed, each red then green: link events now run in arrival order, since a channel's close handled before the `BYE` in front of it showed "Disconnected" instead of "Disconnected by <name>"; and three flaky end-to-end causes in the fixtures (see `docs/TROUBLESHOOTING.md`).

Clicks per case are in `POC-CROSS-PROFILE-WEBRTC.md`. The count in branded Chrome is the manual check below.

## Manual check for the user

In two profiles of branded Chrome: click **Choose folder** in the dashboard, choose `Documents/RECnRun`, and allow. Count the clicks until both dashboards list the other profile's tabs. Then **Disconnect**, and see the same step offered again.
