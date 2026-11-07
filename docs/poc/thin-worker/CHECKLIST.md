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
  - commit: see `git log -- tests/lab/web-master`
- [i] W.5 Cell `W.fsa` (tab and app)
  - red: scratch worktree answering the restore prompt with "Allow this time", `vp run lab:web-master -- tests/lab/web-master/w-fsa.spec.ts -g tab`: failed, `Expected: "granted"`, `Received: "prompt"` (reopen and both restarts read `prompt`)
  - green: `vp run lab:web-master -- tests/lab/web-master/w-fsa.spec.ts`: 2 passed (tab, app), run `2026-11-06T22-53-07.297Z-205f196a-f0cb-405e-8495-e345250763df`
  - commit: see `git log -- tests/lab/web-master/w-fsa.spec.ts`
- [ ] W.6 Job schema, limits, errors, signature
- [ ] W.7 Worker job runner, ledger, executor
- [ ] W.8 Page job submit, journal, reconcile, cancel
- [i] W.9 Deciding cell `W.lifecycle` (stop the spike if it fails)
  - red: scratch worktree whose runner stops once the master link closes, `node scripts/test-container.mjs lab:web-master:local tests/lab/web-master/w-lifecycle.spec.ts`: test 1 failed, `Error: sabotage: master gone` (job FAILED, no POST)
  - green: `vp run lab:web-master -- tests/lab/web-master/w-lifecycle.spec.ts`: 3 passed, run `2026-11-06T22-35-09.757Z-08c38dd4-83af-44a9-85af-adfdb29769f7`
  - commit: see `git log -- tests/lab/web-master/w-lifecycle.spec.ts`
- [i] W.10 Cell `W.trust`
  - red: `vp run lab:web-master -- tests/lab/web-master/w-trust.spec.ts`: test 3 failed, `text over 4096` and `read over 16 KiB` ACCEPTED (run `2026-11-06T23-00-34.692Z-26231483-e8f4-48ca-a9f6-ff28e2661210`); then test 4 failed, `Expected: "UNPINNED_MASTER" Received: "BAD_SIGNATURE"`; negative control (scratch worktree, signature check accepts any key): test 4 failed, `Received: "ACCEPTED"`
  - green: `vp run lab:web-master`: 11 passed (all cells), run `2026-11-06T23-05-22.232Z-3c627f27-b75e-4a94-97e2-5e683becead4`
  - commit: see `git log -- tests/lab/web-master/w-trust.spec.ts`
- [i] W.11 Cell `W.friction`
  - red: negative control (scratch worktree, Store list without the restore pair, 6), `node scripts/test-container.mjs lab:web-master:local tests/lab/web-master/w-friction.spec.ts`: test 3 failed, `Expected: < 6`, `Received: 7`
  - green: `vp run lab:web-master -- tests/lab/web-master/w-friction.spec.ts`: 3 passed (tab 7, app 7, Store 8), run `2026-11-06T23-13-04.506Z-2b85052b-c8c2-4005-a15d-64bb0b189ba8`
  - commit: see `git log -- tests/lab/web-master/w-friction.spec.ts`

Gate W: lab run · verify · review · RESULTS W1–W5 · owner decision

- lab run (`vp run lab:web-master`, run id, result per cell):
- verify:
- review (`reviews/PW.md`):
- owner decision (adopt the website master or keep the extension master):

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
