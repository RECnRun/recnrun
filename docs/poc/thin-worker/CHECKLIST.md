# Thin worker POC: checklist

**Branch:** `poc-thin-worker` (pull request targets `poc-downloads-launcher`)
**Last commit:** `3b37afdf`
**Current phase:** PW
**Paused:** no

## Resume protocol

1. Read [PLAN.md](PLAN.md), this file, and [AGENTS.md](../../../AGENTS.md). The plan's decisions are binding; change one only with the owner.
2. Work in the worktree of `poc-thin-worker`. Check `git status` is clean and `git log -n 1` matches **Last commit**.
3. Take the first `[ ]` task of the current phase. A `[!]` task waits for its reason; a `[~]` task resumes at what is missing.
4. Delegate a task to a Sonnet `plan-implementer` agent by default; use Opus only for Chrome or WebRTC internals. Every brief says agents never open host Chrome: browser layers run only through Docker `vp run test:*`. Only the orchestrator touches host Chrome and the personal Default profile.
5. Every behavior change is red/green, with one commit per task. Under the task, add `red:`, `green:`, and `commit:` lines, and mark it `[i]`.
6. At a phase gate, run Codex review (`gpt-6.1-sol`, high, read-only, stdin closed with `</dev/null`) on the phase's commits. Save it as `reviews/P<n>.md` and fix its findings as tasks.
7. Then run `vp run verify` until it exits 0, record its run id and wall time on the gate's lines, mark the phase's `[i]` tasks `[x]`, and push. Run verify and push only at gates, except that Phase 0 runs a timed verify after every task (pushes stay at the gate). Watch CI in the background.
8. Owner checks go only in [MANUAL_VALIDATION.md](MANUAL_VALIDATION.md); answers go in [RESULTS.md](RESULTS.md).
9. To pause, set **Paused** to the date and the next step, update **Last commit**, and commit this file.

Markers: `[ ]` not started · `[i]` implemented, awaiting the phase gate · `[x]` verified by `vp run verify` · `[!]` blocked (reason indented) · `[~]` partial (what is missing indented)

## PW: website-master spike

Phase 0 and later wait for Gate W. W.4 or W.9 failing stops the spike and goes straight to Gate W.

- [ ] W.1 Add `packages/link` (moved link modules), `packages/worker-protocol`, `apps/worker`, `apps/web-master-lab`; update ARCHITECTURE, dependency-cruiser, Vitest, coverage, jscpd, and Knip
- [ ] W.2 Launcher move step from `<root>/downloads/RECnRun/` to the rendezvous folder
- [ ] W.3 HTTPS stand-in `https://recnrun.test`; page onboarding and pairing; `persist()` answer recorded
- [i] W.4 Deciding cell `W.rtc` (stop the spike if it fails)
  - red: scratch copy with the answer's DTLS fingerprint changed by one byte, `node scripts/test-container.mjs lab:web-master:local -- -g default`: failed, `Error: channel headed did not open`
  - green: `vp run lab:web-master`: 2 passed (default, public), run `2026-11-06T22-18-09.019Z-886ddf42-a879-4c38-b371-798de8a1d80f`
  - review follow-up (finding 8): `vp run lab:web-master -- tests/lab/web-master/w-rtc.spec.ts`: 3 passed
  - commit: 8d9c2c54, c1dd54db
- [i] W.5 Cell `W.fsa` (tab and app)
  - red: scratch worktree answering the restore prompt with "Allow this time", `vp run lab:web-master -- tests/lab/web-master/w-fsa.spec.ts -g tab`: failed, `Expected: "granted"`, `Received: "prompt"` (reopen and both restarts read `prompt`)
  - green: `vp run lab:web-master -- tests/lab/web-master/w-fsa.spec.ts`: 2 passed (tab, app), run `2026-11-06T22-53-07.297Z-205f196a-f0cb-405e-8495-e345250763df`
  - review follow-up (finding 6): red with restores forced at reopen and restart-1, `Expected "granted", Received "prompt"`; green 2 passed
  - commit: c19013ed, c1dd54db
- [ ] W.6 Job schema, limits, errors, signature
- [ ] W.7 Worker job runner, ledger, executor
- [ ] W.8 Page job submit, journal, reconcile, cancel
- [i] W.9 Deciding cell `W.lifecycle` (stop the spike if it fails)
  - red: scratch worktree whose runner stops once the master link closes, `node scripts/test-container.mjs lab:web-master:local tests/lab/web-master/w-lifecycle.spec.ts`: test 1 failed, `Error: sabotage: master gone` (job FAILED, no POST)
  - green: `vp run lab:web-master -- tests/lab/web-master/w-lifecycle.spec.ts`: 3 passed, run `2026-11-06T22-35-09.757Z-08c38dd4-83af-44a9-85af-adfdb29769f7`
  - unattached worker: red 3 of 3 `click` TIMEOUT headed and headless; green `--repeat-each 10` 60 passed, run `2026-11-07T07-03-22.360Z-7c9b98be-cdb4-4580-9294-21c4ad4bcd98`
  - commit: 01eae1cf, b4094c6d, dad3e5b5
- [i] W.10 Cell `W.trust`
  - red: `vp run lab:web-master -- tests/lab/web-master/w-trust.spec.ts`: test 3 failed, `text over 4096` and `read over 16 KiB` ACCEPTED (run `2026-11-06T23-00-34.692Z-26231483-e8f4-48ca-a9f6-ff28e2661210`); then test 4 failed, `Expected: "UNPINNED_MASTER" Received: "BAD_SIGNATURE"`; negative control (scratch worktree, signature check accepts any key): test 4 failed, `Received: "ACCEPTED"`
  - green: `vp run lab:web-master`: 11 passed (all cells), run `2026-11-06T23-05-22.232Z-3c627f27-b75e-4a94-97e2-5e683becead4`
  - review follow-up (findings 1–4, 12): `vp run lab:web-master -- tests/lab/web-master/w-admission.spec.ts`: red 8 of 8 against the old worker; green 9 passed
  - commit: 34110098, 09702d43, 59cbf740, c192f6e4
- [i] W.11 Cell `W.friction`
  - red: negative control (scratch worktree, Store list without the restore pair, 6), `node scripts/test-container.mjs lab:web-master:local tests/lab/web-master/w-friction.spec.ts`: test 3 failed, `Expected: < 6`, `Received: 7`
  - green: `vp run lab:web-master -- tests/lab/web-master/w-friction.spec.ts`: 3 passed (tab 7, app 7, Store 8), run `2026-11-06T23-13-04.506Z-2b85052b-c8c2-4005-a15d-64bb0b189ba8`
  - commit: c574fe00

Gate W: lab run · verify · review · RESULTS W1–W5 · owner decision

- lab run (`vp run lab:web-master`, run id, result per cell): `2026-11-07T07-57-50.325Z-13178a3d-d7c7-437c-bc36-85772e0652d9`, 28 passed (W.rtc 3, W.fsa 2, W.lifecycle 3 headed + 3 headless, W.trust 5, W.admission 9, W.friction 3)
- verify: `vp run verify` exit 0 on d51a4b81 (37 of 37 tasks; marker `.artifacts/verified/d51a4b81…`)
- review (`reviews/PW.md`): Codex, not supported; blocker 1 and majors 2–4, 6, 12 fixed, wording of 5, 7, 11 corrected, the rest carried below
- carried into Phase 1 after a GO ([PW review](reviews/PW.md) findings 5, 9–11, 13): persistent worker identity, onboarding-bound pins, mutual HELLO, authenticated status and results; epoch floor, ledger retention, signed cancellation, resubmission and replay tests; destination, redirect, stale-document, and network-guard checks; a durable publication queue with crash tests; real folder signalling and launcher move with R4 reconciliation; focus emulation in the fixed CDP table and a worker run without lab flags; strict-CSP execution, app closure, suspend and resume; macOS and the real origin (M-TW.12–M-TW.15)
- owner decision (adopt the website master or keep the extension master): adopt the website master, accepting the residual trust risk of W4 and the Phase 1 carry list above (2026-11-07)

## W6: visual observability ([W6-PLAN.md](W6-PLAN.md))

Branch `poc-w6-visual-observability`, from d51a4b81.

- [i] W6.A capture in the worker (G0, G1)
  - red: stub `capture.js` that produces no frame, `RECNRUN_TEST_QUIET=1 vp run lab:web-master -- tests/lab/web-master/w-visual.spec.ts --project headed-worker`: test 1 failed, `Error: Timed out after 15000 ms: null` in `panelShows`, run `2026-11-07T10-35-05.267Z-8339fd19-bda6-4c5a-88fe-9c29fae0f257`
  - green: `vp run lab:web-master -- tests/lab/web-master/w-visual.spec.ts`: 10 passed (5 headed, 5 headless), run `2026-11-07T10-42-25.195Z-50dc80e9-e9b0-48fe-8ed8-13ac8351baa0`
  - commit: 01c945d4
- [i] W6.B binary frames over `visual.v1` (G2)
  - red: stub `encodeFrame` (no message) and `createReceiver` (drops all), `cd tests && vp test run lab/web-master/visual-envelope.test.ts`: 20 failed, 2 passed; `RECNRUN_TEST_QUIET=1 vp run lab:web-master -- tests/lab/web-master/w-visual-link.spec.ts`: test 1 failed, `Error: Timed out after 15000 ms: null` in `masterShows`, run `2026-11-07T10-50-51.819Z-b90c0fb4-a330-4288-b340-50504eba6518`
  - green: `cd tests && vp test run lab/web-master/visual-envelope.test.ts`: 22 passed; `vp run lab:web-master -- tests/lab/web-master/w-visual-link.spec.ts`: 3 passed, run `2026-11-07T10-52-41.679Z-f2bc14e2-0edb-4b3d-95b3-3aa5c15d00e8`; `vp run lab:web-master`: 41 passed, run `2026-11-07T10-53-27.066Z-c6ebb760-63ab-41e1-aadc-72a14f6213e2`
  - commit: e10c607c
- [i] W6.C observe control, trust, and policy (G3)
  - red: scratch-worktree negative controls with `RECNRUN_TEST_QUIET=1 vp run lab:web-master -- <spec>`: live at 60 fps (`w-observe.spec.ts` caps, 161 > 16), no lease tick (`w-observe-life.spec.ts` W6.09 timed out), admit without proof (W6.15, 24 frames shown, want 20), no navigated hook (off-policy timed out); `observe.test.ts` against stubs: 26 failed, 2 passed
  - green: `observe.test.ts` 50 passed (lab unit files); `vp run lab:web-master -- tests/lab/web-master/w-observe.spec.ts tests/lab/web-master/w-observe-life.spec.ts`: 12 passed, run `2026-11-07T11-21-19.857Z-a7128a63`; `w-observe.spec.ts` + `w-visual-link.spec.ts`: 10 passed, run `2026-11-07T11-27-31.551Z-ff8574be`
  - commit: 4e35dcfe
- [i] W6.D dashboard as a tab (G4); the PWA (W6.17) is not tested, by owner decision
  - red: scratch-worktree negative controls with `node scripts/test-container.mjs lab:web-master:local tests/lab/web-master/w-dashboard.spec.ts --project headed-worker`: observe on add (cards `THUMBNAIL`, want `OFF`), close leaves the worker live (`Timed out after 5000 ms: "live"`), no `STREAM_UNAVAILABLE` (status `RUNNING`), no `STALE` (stale false); 1 failed each
  - green: `vp run lab:web-master -- tests/lab/web-master/w-dashboard.spec.ts`: 14 passed (7 headed, 7 headless), run `2026-11-07T11-39-32.980Z-d7f34c3e-181d-4027-9645-7246d56b1c4a`; `w-observe`, `w-observe-life`, `w-visual-link`: 15 passed after the master keyed frames by link
  - commit: af036bc0
- [i] W6.E benchmarks, network faults, no-flags worker run (G5 in the lab); results in [W6-PLAN.md](W6-PLAN.md#slice-e-in-the-lab)
  - red: `w-no-flags.spec.ts` before the worker polled the relay: 1 failed, `Timed out after 20000 ms: null`; scratch-copy negative controls with `node scripts/test-container.mjs lab:web-master:local`: `w-netem.spec.ts -g "path|outage"` with the buffer bound at 10000, 1 failed (`Received: 25814`); `w-observe-friction.spec.ts` with Observe calling `confirm()`, 1 failed (`"dialogs": 1`); `RECNRUN_W6_BENCH=1 vp run lab:web-master -- tests/lab/web-master/w-scale.spec.ts -g "1 worker.*visible"`: 1 failed (`Received: NaN`, no capture time on arrivals)
  - green: `vp run lab:web-master -- tests/lab/web-master/w-no-flags.spec.ts`: 1 passed, run `2026-11-07T11-49-46.409Z-2bf2abfa`; `RECNRUN_W6_BENCH=1 vp run lab:web-master -- tests/lab/web-master/w-netem.spec.ts`: 6 passed, run `2026-11-07T11-57-47.257Z-aba016e9`; `RECNRUN_W6_BENCH=1 … w-scale.spec.ts`: 4 passed, run `2026-11-07T12-12-15.039Z-1e895a86`; `… w-observe-friction.spec.ts`: 1 passed, run `2026-11-07T12-15-36.409Z-4cf477b4`
  - commit: 0014bdb6, 923a7b54, 180a0c98, 5f031a75
- [i] W6 review fixes, worker safety (findings 1, 2, 3, 5, 6 worker side, 9)
  - red: `cd tests && npx vitest run lab/web-master/worker-safety.test.ts lab/web-master/observe.test.ts` against 9f3bcb96 in a scratch worktree: 9 failed, 28 passed
  - green: same command: 37 passed; `node scripts/test-container.mjs lab:web-master:local` `w-visual.spec.ts w-observe.spec.ts`: 17 passed
  - commit: 579b50cb
- [i] W6 review fixes, master admission and bounds (findings 4, 5, 6, 10, 11a, 11c)
  - red: `cd tests && npx vitest run lab/web-master/master-safety.test.ts` against 579b50cb with a stub admission that shows every frame: 10 failed; `worker-safety.test.ts` sender test: 1 failed (`expected 1 to be +0`)
  - green: same commands: 10 and 7 passed; Docker `w-dashboard w-observe w-observe-life w-visual-link`: 29 passed, run `2026-11-07T12-46-20.351Z-e3269e10`
  - commit: 0ad03b8c
- [i] W6 review fixes, measurement and content scans (findings 7, 8, 11b, 11d)
  - red: scratch worktree at 0ad03b8c, `RECNRUN_W6_BENCH=1 node scripts/test-container.mjs lab:web-master:local w-observe-life.spec.ts w-scale.spec.ts`: 2 failed (W6.14 scan `Received: undefined`, no content scan; W6.E 1 worker visible `captureToDisplayMs.n` 0, no paint time)
  - green: `RECNRUN_W6_BENCH=1 … w-scale.spec.ts w-netem.spec.ts`: 10 passed, run `2026-11-07T12-54-04.522Z-754c7c1e`; `… w-observe-life.spec.ts`: 6 passed, run `2026-11-07T12-57-57.886Z-c3642c3d`
  - commit: e2f67f14

Gate W6: full lab 70 passed, 10 bench cells skipped (run `2026-11-07T12-59-40.380Z-9bf89e87`) · verify gates the push · review [PW-W6.md](reviews/PW-W6.md), findings fixed in 579b50cb, 0ad03b8c, e2f67f14 · RESULTS W6.01–W6.20 filled · verdict **GO-LAB-ONLY** (2026-11-07)

## W7: remote interaction ([W7-PLAN.md](W7-PLAN.md))

Branch `poc-w7-remote-input` from edcb5681. Plan reviewed in [PW-W7-plan.md](reviews/PW-W7-plan.md).

- [i] W7.A link-bound start, lease, shared admission (N1–N4, N9, N14, N15)
  - red: `interact.test.ts` against stubs: 33 failed, 5 passed; `RECNRUN_TEST_QUIET=1 vp run lab:web-master -- tests/lab/web-master/w-interact-auth.spec.ts --project headed-worker` with stub checks and no claim exclusion: 8 failed, 1 passed, run `2026-11-07T15-20-41.145Z-ba7bc9a4`; negative controls (no duplicate refusal, no revoke on input close): 1 failed each, runs `2026-11-07T15-21-18.940Z-18737006`, `2026-11-07T15-21-37.004Z-52505129`
  - green: `interact.test.ts` 38 passed; `w-interact-auth.spec.ts` + `w-admission.spec.ts` + `w-observe.spec.ts`: 25 passed, run `2026-11-07T15-22-20.934Z-fbad936a`; `w-interact-auth.spec.ts` after the last edit: 9 passed, run `2026-11-07T15-24-17.316Z-56fa12af`
  - commit: 908b8cda
- [i] W7.B interactive tab, INTERACT capture, mapping, click (I1, N6, N7)
  - red: `interact.test.ts` 2 failed, 52 passed (schema), 13 failed, 41 passed against a stub frames module; `w-interact-click.spec.ts --project headed-worker` with checks off, x scaled by 0.9, no off-policy revoke, no opener close: I1 failed (corner `tr` hit `body`), run `2026-11-07T15-49-21.928Z-c4d3014a`; negatives (STALE_FRAME expected, ok received) `2026-11-07T15-49-47.357Z-6460041d`; N6 (openersClosed 0) `2026-11-07T15-49-53.539Z-95411521`, (no revoke alone: reason undefined) `2026-11-07T15-50-13.691Z-4b0b81f0`; N7 (TARGET_CHANGED expected, ok received) `2026-11-07T15-50-02.672Z-5381f6d2`
  - green: `interact.test.ts` 54 passed (124 across `lab/web-master`); `w-interact-click.spec.ts` headed 4 passed (run `2026-11-07T15-48-57.157Z-1e2a0fe4`; its headless half started a headed worker and is void); headless rerun with a headless worker, checked by its `HeadlessChrome` user agent (red: 1 failed, run `2026-11-07T16-14-20.362Z-ec52842c`; N7 then failed headless because its 800×450 resize matched the headless view, run `2026-11-07T16-14-32.050Z-f3848c48`; the resize now shrinks the current view): headed 4 passed, headless 4 passed, run `2026-11-07T16-15-15.642Z-62b938c3`; INTERACT 24.5 fps headed, 24.0 headless; worst corner error 2.83 CSS px headed, 1.00 headless; headed `w-interact-auth` + `w-observe` + `w-visual` + `w-dashboard` + `w-interact-click`: 25 passed, 1 failed (N4: its `/` start URL is an empty 404, Chrome's error page is off the allowlist, so the lease was revoked), run `2026-11-07T15-50-31.258Z-4733e6ba`; after moving W7.A to `/form`: 9 passed, run `2026-11-07T15-53-19.459Z-5c1da104`
  - commit: e579fd0e
- [i] W7.C keys, text, wheel, pressed-state cleanup (I2, I3, N5, N10)
  - red: `interact-input.test.ts` against stubs: 17 failed, 20 passed; `w-interact-input.spec.ts --project headed-worker -g <cell>` with key/text/wheel refused: I2 (submit undefined) `2026-11-07T16-06-51.965Z-5bd871e0`, I3 (scroll 0) `2026-11-07T16-07-08.960Z-01357933`, negatives (INPUT_UNSUPPORTED instead of TEXT_TOO_LONG) `2026-11-07T16-07-17.609Z-c71c5dd6`; with no releases (no mouseup/keyup): dead man `2026-11-07T16-07-55.868Z-7b440e52`, N5 `2026-11-07T16-08-02.925Z-bea73c70`, N10 `2026-11-07T16-08-08.765Z-eef1817d`
  - green: `lab/web-master` Node tests 161 passed; `w-interact-input.spec.ts` headed 7 passed (run `2026-11-07T16-08-25.460Z-5ef5a671`), headless 7 passed (run `2026-11-07T16-08-38.274Z-3b47f189`); release after the last event 0.92 s (dead man), master close 0.91 s, link loss 5 ms (CLEANUP); `w-interact-click` + `w-observe-life` headed 10 passed (run `2026-11-07T16-08-56.422Z-5a5ef979`)
  - [unsure] service worker restart closes the tab: the lab has no way to stop only the service worker, so not exercised
  - commit: c613002a
- [ ] W7.D drag, latency, congestion check (I4, I5, N8)

Gate W7: not run

## P0: freeze and prune verify

Baseline: run `2026-11-06T18-35-02Z` on `18c4ec12`, 70.8 min.

- [ ] P0.1 Old POC handoff: write `downloads-launcher/RESULTS.md` (findings, abandoned branches, unresolved defects, pending manual checks)
- [ ] P0.2 Move experiments to `lab:downloads-launcher`; promote `E9.restart` and `E9.idempotent` to `tests/browser`
- [ ] P0.3 Delete the eight `E8.discovery.*` cells
- [ ] P0.4 Delete the shared-root worker cases; keep `launcher-first-run-shared` and the refusal checks
- [ ] P0.5 Retire the `poc-d1` and `poc-d2` builds and their manifest checks
- [ ] P0.6 Fix `P6.1.error.retry` with an asserting test
- [ ] P0.7 Delete or keep the spike code according to Gate W

Gate P0: verify · time per task · review

- time per task (verify wall time after each task):
- verify:
- review:

## P1: cold-start vertical slice

Phase W started P1.1, P1.3, P1.5, P1.6, P1.7, P1.10, and P1.12; those tasks finish what it left.

- [ ] P1.1 Add `packages/worker-protocol`, `packages/link`, `apps/worker`; update ARCHITECTURE, dependency-cruiser, the extension rule, and `CHROMIUM.md`; wire Vitest, coverage, jscpd, and Knip
- [ ] P1.2 Build master and worker with distinct pinned ids; pack the versioned package (worker, `bin/`, `SHA256SUMS`)
- [ ] P1.3 `worker-protocol` schemas, negotiation, limits, errors
- [ ] P1.4 CDP method table and `scripts/worker-cdp.checks.mjs`, wired into `test:scripts:local`
- [ ] P1.5 Worker ledger and retention (`EPOCH_FULL`, no eviction inside an epoch)
- [ ] P1.6 Executor with origin, destination, and document checks and the `Fetch` guard
- [ ] P1.7 Move the link to `packages/link` with FSA and Downloads adapters (jscpd at most 1%)
- [ ] P1.8 Rendezvous onboarding: picker, marker, persistent consent, recovery action
- [ ] P1.9 Trusted master pin in the launcher record; `clone-open.sh` never reads presence for the key
- [ ] P1.10 Launcher move step into the rendezvous folder (started in W.2); cell `P1.rendezvous-move`
- [ ] P1.11 Exclude frozen bases and unpublished copies through the registry and the role check
- [ ] P1.12 Strict-CSP fixture server with POST counter
- [ ] P1.13 Cold-start slice spec (H-CSP recorded)
- [ ] P1.14 Rejection spec
- [ ] P1.15 Restart and replay spec
- [ ] P1.16 Deciding cell `P1.master-fsa` (replaced by `W.fsa` if the website master is adopted)

Gate P1: verify · slice specs time · RESULTS H1–H8 · review

- verify:
- slice specs time:
- review:

## P2: replace and retire

- [ ] P2.1 Replace `forged-sender`
- [ ] P2.2 Replace `hierarchy` and `dashboard-open-tab`
- [ ] P2.3 Classify every E13 and E10 case: replace, keep as assertion, or move to the lab
- [ ] P2.4 Retire the worker-to-worker mesh
- [ ] P2.5 Retire the one-extension-many-roles code
- [ ] P2.6 Adapt FSA folder pairing to the master flow only
- [!] P2.7 One presence policy as default, others removed
  - owner decides the policy (proposed: `launcher`)

Gate P2: verify · time against Gate P0 · coverage per file · review

- verify:
- review:

## P3: update existing clones

- [ ] P3.1 Immutable versioned bundles under `~/RECnRun/app/<version>/`
- [ ] P3.2 Stopped-clone update keeps identity, pin, and ledger
- [ ] P3.3 Garbage-collect unreferenced bundles

Gate P3: verify · review

- verify:
- review:

## P4: version skew

- [ ] P4.1 N−1, N, N+1 negotiation matrix
- [ ] P4.2 Mixed-version cell

Gate P4: verify · review

- verify:
- review:

## P5: headed clones

- [ ] P5.1 `--silent-debugger-extension-api`, no infobar
  - `[unsure]` xdotool and scrot on Xvfb; port `tests/desktop` if not
- [ ] P5.2 DevTools contention
- [ ] P5.3 Detach behavior
- [ ] P5.4 Headed to headless to headed

Gate P5: verify · review

- verify:
- review:

## P6: Store-like master, one-line install, and friction

- [ ] P6.1 Packed CRX id check
- [ ] P6.2 Gesture count from the install command (owner sets the target)
- [ ] P6.3 "Ask where to save" handling
- [ ] P6.4 Reboot recovery with no terminal (Linux claimed only after M-TW.11)
- [ ] P6.5 README gesture count and owner runbook
- [ ] P6.6 `install.sh` served from `apps/website` with its SHA-256; piped, re-run, upgrade, repair, `--uninstall`, `--dry-run`
- [ ] P6.7 Installer lint over `install.sh` and every package script, wired into `test:scripts:local`
- [ ] P6.8 Checksum mismatch, partial download, truncated script install nothing
- [ ] P6.9 End-to-end from the install command to a script on a new clone
- [ ] P6.10 Installer trust review (Codex and Claude, orchestrator only, not in verify); plus a package-script audit; rerun whenever `install.sh` or a package script changes

Gate P6: verify · gesture count · installer trust review · review

- verify:
- gesture count:
- installer trust review (`reviews/installer-trust-<date>.md`, script SHA-256):
- review:

## P7: manual acceptance and soak

- [ ] P7.1 `lab:thin-worker-soak`
- [ ] P7.2 Owner checks M-TW.1–M-TW.11 and RESULTS

Gate P7: soak run · owner checks · review

- soak:
- review:

## P8: Windows (not executed)

- [!] P8.1 Windows evidence environment
  - no environment yet; `install.ps1` is not served before P8.3 passes
- [!] P8.2 Port launcher, provisioning, and cloning
- [!] P8.3 `install.ps1` with lint and loopback tests
- [!] P8.4 Owner checks on Windows

## Open items carried from downloads-launcher

- `P6.1.error.retry` → P0.6
- "Ask where to save" warning → P1.16, P6.3
- Base download folder: option B (move step) is the default; the owner may still choose the `chrome://settings/downloads` route → P1.10
- README `4 N + 3` gesture count and the runbook's Documents and Full Disk Access steps → P6.5
- `launcher` presence policy default → P2.7
- E9 backoff, stop, and pause → lab only, until the launcher review
- Pending owner checks M-P1.a … M-P7.a → listed in the old RESULTS handoff (P0.1)
