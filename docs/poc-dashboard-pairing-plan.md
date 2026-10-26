# Plan: pairing from the dashboard alone

Branch `poc/dashboard-only-pairing`, stacked on `poc/cross-profile-webrtc-v2` (PR #13). It carries out the "Next phase" of `docs/poc-cross-profile-usability-plan.md`, decided on 2026-10-26.

## Goal

In each Chrome profile the user opens the site and clicks the dashboard's button to set up the RECnRun folder, and pairing completes with nothing else to do. After a disconnect, the dashboard offers the same step again. `pairing.html` goes away. What stays is the smallest top-level extension window Chrome needs for its picker and prompts (H2): it grants the folder, waits until the profiles pair, and closes itself.

## Decisions

- **The manual code flow goes.** The page requests `create-offer`, `inspect`, and `accept`, the six-digit check, and the `PairingPreview` result are removed. Folder pairing keeps the offer and answer codes it writes to the folder, and `linkUp`'s certificate check.
- **Ping and diagnostics go** (the user's choice). `Send ping` and `Show diagnostics` existed only on the pairing page. Their requests, and protocol messages or link commands no one else uses, are removed. Test B proves the link with the other profile's tabs in each dashboard and the frames each background exchanged.
- **The dashboard gains a "Pairing" section** under the tab lists, replacing "Manage pairing": the profile's name with **Save name**, the link in words (the pairing page's status line), the existing **Pair with another profile** or **Reconnect** step, **Disconnect** while connected, and **Forget <name>** while a peer is pinned.
- **The folder window is the only extension page left.** It opens from the banner, as today; `pairing.html` without `#folder` no longer exists. Renaming the entrypoint to `folder.html` and `src/pairing` to `src/folder` is the last task, with `.dependency-cruiser.cjs` and `docs/ARCHITECTURE.md`.
- **Every end-to-end test pairs through the real folder**, driven by `native-dialogs.ts`, since the picker is never mocked. The profiles fixture opens each profile's site tab and names the profile in its dashboard, and `pair(a, b)` chooses the folder in each through the window.

## Tasks

1. **Dashboard pairing section.** Component tests first (name, status words, Disconnect, Forget, the step), then the section. Additive: the pairing page still works.
2. **End-to-end tests through the dashboard.** The fixture and `cross-profile-{link,tabs,isolation}.spec.ts` and `folder-pairing.spec.ts` stop using the pairing page. Tests only, while the page still exists.
3. **Remove the pairing page and the manual flow.** `PairingPage.tsx`, `PairingSteps.tsx`, `FolderSection.tsx`, `openPairing`, the manual requests, ping, diagnostics, and their tests. `startPairing` renders only the folder window.
4. **Rename** `pairing` to `folder` (entrypoint, source folder, dependency rules, manifest guard).
5. **Docs.** `POC-CROSS-PROFILE-WEBRTC.md` (tests B and K, the clicks per case, "Before production"), `docs/POCS.md`, `docs/ARCHITECTURE.md`, `.claude/rules/extension.md`, and this plan's results.

Each task is one commit with `Red:` and `Green:` lines where behavior changes, and `vp run verify` exits 0 at the end.

## Manual check for the user

In two profiles of branded Chrome: open the site, click **Choose folder** in the dashboard, choose `Documents/RECnRun`, and allow. Count the clicks until both dashboards list the other profile's tabs. Then **Disconnect**, and see the same step offered again.
