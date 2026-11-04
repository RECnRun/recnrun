# Checklist

Tracks [PLAN.md](PLAN.md). One line per task; the orchestrator owns `[x]`, implementers own `[i]`. This file is the resume point: a new session reads it and continues without the previous conversation.

## Resume protocol

1. Read [PLAN.md](PLAN.md) §1, §2, §4, and the section of the current phase; this file; [MANUAL_VALIDATION.md](MANUAL_VALIDATION.md); the experiment reports of the current phase under `experiments/`. Do not read the source document unless a task cites a section this plan does not restate.
2. The worktree is `.claude/worktrees/poc-downloads-launcher` of `/Users/dannyelcf/src/recnrun`, branch `poc-downloads-launcher`. `git status` is clean and `git log --oneline -1` matches **Last commit** below; otherwise stop and report. Run `vp install` after a pull.
3. Take the first task of the current phase that is `[ ]`. Do not start a later phase while an earlier one has `[ ]` or `[!]` tasks, unless the owner says so. P6 (V3) does not block the results of V1 and V2 and may run after P7 if the owner prefers.
4. Delegate (PLAN.md decision 9). Sonnet: ports, schemas, docs, generated reports. Opus: Docker, Chrome, launcher scripts, experiments. The orchestrator itself: gates, cherry-picks, Codex reviews, pushes, and every cell that touches the personal Default profile. Each brief lists the task IDs, a reading list of exact files (never "read the repo" or whole directories), the files the agent may change, the Docker commands and the throwaway roots it may use, and the cap on hand-backs. Agents work in their own worktree started at `poc-downloads-launcher` (`git reset --hard poc-downloads-launcher` then `vp install`) and are removed after the cherry-pick.
5. Implement with red/green and one commit per task (`.claude/agents/plan-implementer.md`). Mark `[i]` with indented `red:`, `green:`, and `commit:` lines. An experiment task records `verdict:` lines, one per hypothesis, with the environment. A host cell records a `host:` line with the run id under `.artifacts/evidence/host/` and the gesture counts.
6. A phase closes when the orchestrator runs `vp run verify` (exit 0), records the host cells the phase owns, obtains the Codex review (step 7), marks every task `[x]`, records the gate lines, pushes the branch (`GIT_SSH_COMMAND="ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=20"`, foreground, long timeout; the shared pre-push hook runs `vp run verify`), and updates the pull request against `poc/multi-profile-mesh`.
7. **Codex review before a phase closes.** `codex exec --ephemeral -s read-only -m gpt-6.1-sol -c model_reasoning_effort=high` with a prompt naming the commit range, the task IDs, and `AGENTS.md`. Evaluate every finding; apply the pertinent ones with red/green, one commit each; reject the rest with a reason; save the full text as `reviews/P<n>.md` (absolute paths turned into relative links); record `review:` on the gate line (date, findings, applied, rejected with reasons). A review that was not run blocks the gate.
8. Manual items are tracked only in [MANUAL_VALIDATION.md](MANUAL_VALIDATION.md); never mark a task `[x]` on the strength of a manual check.
9. Pausing: before the session ends, update **Last commit**, **Current phase**, and the **Paused** note below with what is in flight (agent worktrees and their branches, background runs and their logs, unpushed commits), then push if the gate allows. Memory of the orchestrator points here; the conversation is not the record.

Markers: `[ ]` not started · `[i]` implemented, awaiting the phase gate · `[x]` verified by `vp run verify` · `[!]` blocked (reason indented) · `[~]` partial (what is missing indented).

**Branch:** `poc-downloads-launcher` (from `60989d6`, head of PR #19 `poc/multi-profile-mesh`)
**Last commit:** the commit whose subject is "Close Gate P0 with the Codex review and the egress task" (after `70c5325`)
**Current phase:** P1 (start with P1.0)
**Paused:** 2026-11-03 at Gate P0 closed: nothing in flight, no agent worktrees. Owner decisions recorded in PLAN.md decisions 1, 3, 4, 9 (host Chrome allowed including the personal Default; packed not executed; §13 order; PR against `poc/multi-profile-mesh`). Owner clarified on 2026-11-03 that the debugger axis means headed and headless, with and without `chrome.debugger`, infobar recorded (PLAN.md P8.2).

## P0: Base, lab, baseline, and Chromium inventory

- [x] P0.1 Plan documents and `docs:check`
      red: `node <scratch>/scripts/check-docs.mjs <scratch>` with `MANUAL_VALIDATION.md#nope` in a scratch copy of PLAN.md exits 1: `broken anchor MANUAL_VALIDATION.md#nope`
      green: `node --test scripts/check-docs.checks.mjs` 8 passed; `vp run docs:check` exits 0; `vp check` clean
      commit: `0bf18cc` Port the Markdown link checker and register the POC in the docs (cherry-picks of `049a482` and `226b406`, adapted)
- [x] P0.2 Baseline of the base (verify counts, Google Chrome Stable in Docker, mesh regressions)
      baseline: `vp run verify` on `60989d6` (detached scratch worktree, 2026-11-03) exit 0 · 64 files / 450 unit+component tests · 66 E2E passed (4.2 min, mesh specs included) · coverage 99.10 stmts / 97.42 branches / 97.98 funcs / 99.55 lines · Vite+ 1.4.0, Node 24.21.0, pnpm 12.14.0, Playwright 1.64.1 in the image
      red: `vp run test:container` before the Dockerfile change failed 7 of 16 (`target stage "runtime" could not be found`, no versions.json, no evidence copy, unknown `test:experiments:local`)
      green: `vp run test:container` 16 passed; the image reports Google Chrome 156.0.8078.79
      commit: `9037c6b` Run Google Chrome Stable in the Docker test image
- [x] P0.3 Browser and experiments layers on branded Chrome, E0 install methods, report `experiments/E0.md`
      red: `chrome.spec.ts` against Playwright's Chromium: `Not Google Chrome: Google Chrome for Testing 156.0.8078.4`; `--load-extension` added to `chrome.ts`: `--load-extension is forbidden on Google Chrome`; E0 with a missing build path and no policy file: both verdicts `fail`, spec still passes; E0 with `E0.managedPolicy` not run: spec fails on "every hypothesis ran"; mesh with profile B on another folder: stays `Not paired` after 30 s
      green: `vp run test:browser` 3 passed (both roots `Connected` through Chrome's own picker and write prompt in 8 s); `vp run test:experiments` 3 passed, 3 samples per hypothesis; smoke mode writes 1 sample
      verdict: E0.loadUnpacked pass (lab, diagnostic, externalClient true: installs over CDP, worker answers, same id on reinstall) · E0.loadUnpacked.persists fail (after a quit and relaunch of the same root with the same flags the prefs entry is gone, `{ onDisk: false }`, no worker, no dashboard, 3 of 3; agrees with CHROMIUM.md group 9 `CleanUpCdpInstalledExtensions`) · E0.managedPolicy pass (lab, strict, no CDP; location 7, survives SIGTERM quit and relaunch) · Google Chrome 156.0.8078.79 on Linux in Docker · files `experiments/verdicts/E0-lab-{full,smoke,versions}.json` regenerated in `70c5325`
      commit: `9a58739` browser layer and CDP allowlist · `a2cd795` E0 verdicts · `f33275a` mesh over the folder in the lab · `7fcc30e` committed verdicts · report `experiments/E0.md` pending (P0.6 agent)
- [x] P0.4 Chromium inventory `CHROMIUM.md`
      green: 9 groups pinned at `refs/tags/156.0.8078.80` (mirror `chrome/VERSION` MAJOR=156 PATCH=80); only the `--enable-unsafe-extension-debugging` gate is `unavailable`; orchestrator spot-checked `ExtensionPrefs::CleanUpCdpInstalledExtensions` (extension_prefs.cc:2213, 2611) and `Manifest::ShouldAlwaysAllowFileAccess` (manifest.h:98) against the mirror; `vp run docs:check` exit 0
      commit: `2717ba3` Add the Chromium source inventory for the POC hypotheses
- [x] P0.5 Host runner `vp run test:host`
      red: `roots.test.ts` against a guard that accepted everything: 7 of 9 failed; first `rootFor` wrote through a symlinked `roots` folder (1 failed); `env -u RECNRUN_HOST_ROOTS vp run test:host` refused: `RECNRUN_HOST_ROOTS is not set`; runner accepted `test:host` as a Docker target
      green: `roots.test.ts` 9 passed (host and Docker); `vp run test:container` 17 passed; lab `chrome.spec.ts` 2 passed and `mesh-two-profiles.spec.ts` 1 passed after the fixture refactor
      host: `RECNRUN_HOST_ROOTS=~/Documents/RECnRun/poc-downloads-launcher vp run test:host tests/host/chrome.spec.ts` 3 passed, 1 skipped (strict `Load unpacked` needs `RECNRUN_HOST_GESTURE=1`); orchestrator run `host-2026-11-03T21-49-21.082Z`: `Chrome/156.0.8078.80`, macOS 27.0.1 (26A434) arm64, roots removed, 0 gestures; agent run `host-2026-11-03T21-40-21.549Z` same result
      commit: `0c67d57` Add the host runner for the installed Google Chrome on macOS
- [x] P0.6 Namespace and evidence schema
      red: `vp run test:unit` with a permissive stub `schema.ts`: `experiments/schema.test.ts (8 tests | 6 failed)`, `expected [Function] to throw an error`
      green: `vp run test:unit` 376 passed, `schema.test.ts` 9 passed (refuses a verdict without `environment` or `install`, an unknown `verdict`, an extra key, negative gestures, an unknown `templateState`; both committed E0 files parse)
      commit: `0b40a1e` Validate the experiment evidence with Valibot schemas · `4f40b4f` Report experiment E0 on the two lab install methods · `70acce2` Run only the E* specs under the experiments Playwright config (fix for the verify failure `Cannot read properties of undefined (reading 'config')` at `schema.test.ts:35`)

Gate P0: verify · baseline counts · Chrome versions (lab, host) · review

- verify: `vp run verify` on `70c5325` exit 0 (2026-11-03, 30 of 30 tasks): 70 files / 499 unit+component · 66 E2E · browser 3 · experiments 4 in smoke mode · coverage 99.10 / 97.42 / 97.98 / 99.55 (earlier run on `0c67d57`, before the review fixes: 68 / 477, also exit 0)
- chrome: lab Google Chrome 156.0.8078.79 on Linux (Ubuntu noble) in Docker · host Google Chrome 156.0.8078.80 on macOS 27.0.1
- host: macOS 27.0.1 (26A434) arm64 · Google Chrome 156.0.8078.80 (`/Applications/Google Chrome.app`) · Docker 28.5.1 · host `vp` 1.0.0-rc.0 on Node v22.22.2 (the image runs Vite+ 1.4.0 on Node 24.21.0, pnpm 12.14.0)
- review: Codex `gpt-6.1-sol` high, 2026-11-03, commits `60989d6..0c67d57`, 8 findings ([reviews/P0.md](reviews/P0.md)). Applied with red/green, one commit each: 1 host roots that alias the approved folder or already exist are refused, marker-guarded teardown (`90b07e4`); 6 `unavailable` verdicts carry a reason with no sample (`a5e7c71`); 7 strict verdicts refuse an external client or `loadUnpacked` (`5ff8b45`); 5 managed policy written only inside the container, exclusive create, own-file cleanup (`7761378`); 3 E0 records the relaunch state before reinstalling, new hypothesis `E0.loadUnpacked.persists` fail, evidence regenerated (`70c5325`). Rejected: 2 egress guard, pertinent but a new task, scheduled as P1.0 before any Downloads cell (PLAN.md §4 container row and P1.0); 4 `evaluate` bypass of the observer scan: `evaluate` runs only in `diagnostic` cells and strict cells have no CDP client at all, so the guard is the absence of the client, revisited when an approval cell gets an observer (P3); 8 Chrome package pin: Google's apt repository serves only the current stable, a pin breaks the image at every release, and the version is recorded per run in `versions.json` and in every verdict, which is the reproducibility §11.1 asks for.

## P1: Downloads write and `file://` read

- [i] P1.0 Lab egress guard (internal Docker network `recnrun-tests` with an on-link default route, Codex P0 finding 2)
  red: `node --test tests/container/runner.checks.mjs` against the `--network none` runner: `test:local` had networks `[]`, not `['recnrun-tests']`, and an external `recnrun-tests` was not refused; with the network but no route step: `'create' !== 'NET_ADMIN'` and Dockerfile.tests had no `iproute2`; `no-egress.spec.ts` on the default network (scratch worktree at `cc49e99`): `dns.lookup` resolved to 172.66.147.243, TCP 1.1.1.1:443 connected, navigation "navigated with status 200", worker fetch "resolved" (4 failed, loopback control passed); `--network none` failed the mesh at "Connecting — Profile B" and 17 e2e and 8 component WebRTC tests; the internal network without a route failed `peer-link.browser.test.ts` (7 timeouts in verify; a two-peer page probe gathered no candidate, and one host candidate and `connected` once the route was added)
  green: `vp run test:container` 20 passed; `vp run test:components` 13 files / 82 tests passed; `vp run test:browser -- tests/browser/no-egress.spec.ts` 5 passed; the mesh with Chrome's defaults and no flag; egress errors: `dns.lookup` `EAI_AGAIN`, TCP `EHOSTUNREACH` (after about 3 s, cap 10 s), navigation `net::ERR_NAME_NOT_RESOLVED`, worker fetch "Failed to fetch"; policy install unchanged (its update server is loopback)
  commit: cherry-picked from agent/p1-egress 51af201 (Run every Docker test on an internal network with no route out); SHA recorded at the gate
  review-fix: Codex P1 finding 1 (`--internal` still reaches the gateway and peer containers): the entry filters the container's egress to `lo` (iptables nf_tables backend, `REJECT` admin-prohibited, mDNS multicast accepted only for its loop copy, `tc` matchall drop on `eth0` egress). Red: `node --test tests/container/image.checks.mjs` `The input did not match the regular expression /apt-get install[^\n]*\biptables\b/`; `vp run test:browser -- tests/browser/no-egress.spec.ts` on the old image 3 failed: gateway 172.21.0.1:80 `timeout`, :443 `ECONNREFUSED` (expected `EHOSTUNREACH`), peer 172.21.0.3 UDP send `sent` (expected `EPERM`; TCP `EHOSTUNREACH` after the ARP timeout); the mDNS control in a scratch worktree at `9b8b40c`: eth0 dropped `NaN` frames; the first filter without the mDNS exception failed 7 `peer-link.browser.test.ts` timeouts. Green: `vp run test:container` 21 passed; `vp run test:browser` 13 passed (mesh-two-profiles included); `vp run test:components` 13 files / 82 tests passed; `vp run test:e2e` 66 passed; errors: gateway :80 and :443 `EHOSTUNREACH` at once, peer TCP `EHOSTUNREACH` and UDP `EPERM`, 1.1.1.1:443 `EHOSTUNREACH` in 1 ms, DNS `EAI_AGAIN`, mDNS looped back with 1 frame dropped on eth0, the eth0 address connects through `lo` and still sources the UDP route
- [i] P1.1 POC build variants `poc-d0`, `poc-d1`, `poc-d2`
  red: `vp run test:extension-manifest` with the new checks before the config change: `poc-d0/d1/d2 declare their permissions...` fail, actual `[ 'storage', 'tabs' ]` vs expected `[ 'storage', 'tabs', 'offscreen', 'downloads', 'debugger' ]`
  green: `vp run test:extension-manifest` 11 passed (production + three POC builds); `origins.test.ts` 8 passed; production and test manifests byte-identical before and after (empty `diff`); negative control in a scratch worktree, production with `downloads`: 2 checks fail; pinned id `omllgeochjfpkjbkpcgjmnnbncdpiedd`
  commit: cherry-picked from agent/p1-variants 45da8e7 (Add the POC build variants with a pinned extension id); SHA recorded at the gate
  follow-up: `host_permissions: ["file:///*"]` added to the POC variants after E1 showed `fetch(file://)` needs it besides the toggle; red `vp run test:extension-manifest` 3 POC checks fail (`host_permissions` undefined), green 11 passed, production manifest byte-identical (Give the POC variants the file host permission)
  review-fix: Codex finding 4 (the background and dashboard predicates left the mesh and pairing UI out of the POC builds). red: new `manifest-poc.checks.mjs` test on the pre-fix POC builds: `The input did not match the regular expression /The other profile is not connected\./`; green: `vp run build:poc` then `node --test scripts/manifest.checks.mjs scripts/manifest-poc.checks.mjs` 22 passed (production leave-out checks included), `diff -r` of the production `.output/chrome-mv3` before and after empty
  review-fix: Codex finding 10 (diagnostics entrypoint held logic and trusted replies). red: `npx vitest run tests/diagnostics.test.ts` in `apps/extension` against a reply-validation stub: 4 failed `promise resolved "undefined" instead of rejecting`; green: same command, 10 passed; `vp run test:extension-manifest` passed, built `diagnostics.html` loads one script, production `diff -r` empty
- [i] P1.2 Clean install and the file-scheme state, E1 (lab, host), report `experiments/E1.md`
  red: `vp run test:experiments -- tests/experiments/E1-file-access.spec.ts` before the build wiring: `The poc-d0 build has no manifest.json at /workspace/apps/extension/.output/chrome-mv3-poc-d0; run vp run --no-cache extension#build:poc-d0.`; first round (`223b800`, P1.1 build with no `file:` host permission): `E1.unpacked.toggleOn` fail "after the toggle on, fileSchemeAccess true, fetch failed (TypeError: Failed to fetch)"; toggle control in a scratch worktree (`toggleSample` expecting `fileSchemeAccess === !target`): `E1.unpacked.toggleOff` verdict `fail` "after the toggle off, fileSchemeAccess false, fetch failed (TypeError: Failed to fetch)"; schema control with `gestures` removed: `Invalid verdicts at 0.gestures: Invalid key: Expected never but received "gestures"`; `cdp-client.test.ts` with the detach handler removed: `expected Error: Browser.getVersion: no reply withi… to be an instance of CdpDetachedError`
  green: with the P1.1 follow-up (`host_permissions: ["file:///*"]`): `vp run test:experiments -- tests/experiments/E1-file-access.spec.ts` 9 passed in 20.7 s, 3 samples per hypothesis (run `2026-11-03T23-23-38.584Z-5df92a62-1563-4349-9204-dc247ed597b9`); smoke (`RECNRUN_EXPERIMENT_SAMPLES=smoke`) 9 passed in 7.3 s, same verdicts (run `2026-11-03T23-24-21.445Z-55ef947e-d163-4a99-b6ad-a4eddd796449`); `vp run test:unit` passed; `vp check`, `vp run deps`, `vp run docs:check` clean
  host: `RECNRUN_HOST_ROOTS=~/Documents/RECnRun/poc-downloads-launcher vp run test:host tests/host/E1-file-access.spec.ts` 10 passed in 32.7 s; run `host-2026-11-03T23-24-49.000Z`: `Chrome/156.0.8078.80`, macOS 27.0.1 (26A434) arm64; 6 cells sampled 3 times (gestures 0, 2, 3, 2, 0, 1, all `cdp-click`), 3 `unavailable`; afterwards no Chrome on the roots and `roots/` empty
  verdict: E1.unpacked.default fail lab and host (access true and the fetch reads the probe with no gesture; pref `newAllowFileAccess: true`, flags 32806) · E1.unpacked.toggleOff pass lab and host (2 gestures: Developer mode, toggle) · E1.unpacked.toggleOn pass lab and host (3 gestures; the read follows the toggle) · E1.unpacked.reinstall fail lab and host (the revoke survives quit, relaunch, and reinstall; the toggled install still runs after a relaunch, flags 38) · E1.unpacked.noHostPermission pass lab and host (control with `host_permissions` removed: access true, fetch `TypeError: Failed to fetch`) · E1.unpacked.noDeveloperMode pass lab and host (toggle with Developer mode off disables the build, `unsupportedDeveloperExtension`) · E1.policy.default pass lab (strict, location 7, no access pref; fetch unavailable without a channel), unavailable host (no system plist) · E1.packed unavailable lab and host (decision 4, M-P9.c) · E1.gesture.default unavailable host (M-P1.a) · lab Google Chrome 156.0.8078.79 on Linux in Docker, xdotool every click · files `experiments/verdicts/E1-{lab-full,lab-smoke,lab-versions,host}.json`
  review-fix: Codex P1 finding 5, `takeSamples` in `outcome.ts` keeps only what a measurement returned; a setup or harness error propagates, fails the test, and writes no verdict, for E1, E3, and E2 (which records through it since finding 9); red `vp test --project=harness tests/experiments/outcome.test.ts`: 2 failed (`promise resolved "{ experiment: 'EX', …(15) }" instead of rejecting`); negative control in a scratch worktree at `e5d6291` with `launchProbe` throwing "diagnostics page never started": E2 smoke 11 passed, every cell a `fail` verdict with one sample; green `outcome.test.ts` 4 passed, the same injection on the fix: 11 failed (each cell test with `Error: diagnostics page never started`, then the completeness test); E1 smoke 9 passed, same verdicts (run `2026-11-04T00-14-55.662Z-a93bed85-be9d-407a-a77a-939d90a7a4e0`, Google Chrome 157.0.8103.38, `E1-lab-smoke.json` replaced); E3 smoke 6 passed, same verdicts (run `2026-11-04T00-15-08.427Z-f4ed40fe-02ce-4902-97f0-263c98d7b669`, `E3-lab-smoke.json` replaced)
  commit: `223b800` first round and harness · the commit that adds this line (rerun on the fixed build)
- [i] P1.3 Probe write and real path, E2 (lab, host)
  red: `npx vitest run tests/downloads-rendezvous.test.ts` against a stub `readTolerant` that kept nothing: `Tests  30 failed | 2 passed (32)`; `npx vitest run tests/downloads-publisher.test.ts` against a listener that ignored every message: `Tests  6 failed | 1 passed (7)`, `expected 'ignored' to match object { ok: true, result: { id: 1 } }`; `vp run test:experiments -- tests/experiments/E2-downloads-probe.spec.ts -g E2.write.completes` with the diagnostics page lacking `__poc`: verdict fail, `window.__poc.probe is not defined on the diagnostics page`; negative control in a scratch worktree, `readTolerant` accepting partial JSON: `Tests  3 failed | 29 passed (32)`
  green: `vp run test:unit` 56 files / 450 tests passed; `downloads-rendezvous.test.ts` 32 and `downloads-publisher.test.ts` 8 passed; `vp run test:experiments -- tests/experiments/E2-downloads-probe.spec.ts` full 11 passed in 1.2 min (run `2026-11-03T23-36-54.382Z-9c60631f`), smoke 11 passed in 24 s (run `2026-11-03T23-44-32.508Z-db206fa7`), Google Chrome 157.0.8103.38 on Linux; `vp run test:extension-manifest` 11 passed, production `background.js` has no `downloads.download` and the production build is byte-identical to `ae5a735`
  host: `RECNRUN_HOST_ROOTS=~/Documents/RECnRun/poc-downloads-launcher vp run test:host tests/host/E2-downloads-probe.spec.ts` run `host-2026-11-04T00-24-46.606Z` (after the review fixes; first round `host-2026-11-03T23-38-29.899Z`), Google Chrome 156.0.8078.80, macOS 27.0.1 (26A434) arm64: 12 cells (10 run, `E2.saveAs.prompt` and `E2.traces.ui` unavailable), 13 passed, 0 gestures; afterwards no launched Chrome, no root left, nothing under `~/Downloads/RECnRun`
  verdict: E2.write.completes pass / pass
  verdict: E2.filename.fileUrl pass / pass
  verdict: E2.overwrite.100 pass / pass (one name, no `(1)`, 4 ms and 77 to 92 ms per write)
  verdict: E2.content.roundTrip fail / fail (`?` refused with `Invalid filename`; `%` became `_`)
  verdict: E2.interrupted.cancel pass / pass (`USER_CANCELED`, a `.crdownload` while running, nothing left, exact publication kept)
  verdict: E2.interrupted.network pass / pass (the source stays down: Chrome restarts once under the URL's name, then `NETWORK_FAILED` with no cancel, nothing left)
  verdict: E2.saveAs.prompt pass, 1 gesture / unavailable (macOS has no xdotool or scrot; M-P1 manual not scheduled)
  verdict: E2.location.custom pass / pass
  verdict: E2.location.default pass / pass
  verdict: E2.traces.history pass / pass (1 entry after one write; 101 after 100 more overwrites)
  verdict: E2.traces.ui pass / unavailable (lab: Chrome's window listed, no new window, the bubble in the screenshot; host: not observable)
  verdict: E2.path.absoluteRefused pass / pass
  review-fix: Codex finding 7 (an expired replacement dropped a valid cache; future `createdAt` accepted; comparison against an expired previous). red: `npx vitest run tests/downloads-rendezvous.test.ts` in `apps/extension`, 3 failed (`expected { publication: undefined, ... } to deeply equal { publication: { ... }, ... }` for the expired replacement and the valid-after-expired cases; the future case returned the future publication); green: same command, 34 passed
  commit: the commit that adds this line (Probe Downloads writes and their real path in experiment E2)
  review-fix: Codex P1 finding 8, `E2.traces` split into `E2.traces.history` (exactly one `chrome.downloads.search` entry, the probe's, after one write; the count after 100 overwrites recorded) and `E2.traces.ui` (lab only: Chrome's window listed before and after, a screenshot taken; `unavailable` with its reason on the host); E2.md no longer says both environments agree on the prompt; red `vp test --project=harness tests/experiments/downloads-traces.test.ts` against today's rule (the probe reply alone): 3 failed, the review's in-memory controls (a failed history query, an empty display) gave no problem; green 6 passed
  rerun: lab full 13 passed (run `2026-11-04T00-23-27.338Z-efaba3ab-2547-40a6-b883-c3fd4f6dec0e`), lab smoke 13 passed (run `2026-11-04T00-24-26.752Z-82231c17-1aff-42ac-a408-278c1a143080`), Google Chrome 157.0.8103.38; host 13 passed in 1.2 min (run `host-2026-11-04T00-24-46.606Z`), Google Chrome 156.0.8078.80, macOS 27.0.1 (26A434) arm64, 0 gestures, 2 `unavailable`; afterwards no Chrome on the roots, `roots/` empty, no `~/Downloads/RECnRun`, the `~/Downloads` listing unchanged; files `experiments/verdicts/E2-{lab-full,lab-smoke,lab-versions,host}.json` replaced
  review-fix: Codex P1 finding 6, `E2.interrupted.crdownload` split into `E2.interrupted.cancel` and `E2.interrupted.network`; the verdict (`interruptionProblems`, `tests/experiments/fixtures/downloads-interrupted.ts`) requires a `.crdownload` seen while running, the expected `DownloadItem.state` and error reached within 15 s with no harness cancel, the exact previous publication during and after, unchanged `probe.json` bytes, and nothing partial or stray left; the network source stays down after the drop; red `vp test --project=harness tests/experiments/downloads-interrupted.test.ts` against today's rule (four reads keep the `profileId`): 4 failed, the review's control with no partial and a `complete` download returned no problem (`expected [] to include 'no .crdownload was seen while the dow…'`); green 6 passed; lab `-g E2.interrupted` full 2 passed (run `2026-11-04T00-21-10.223Z-9d433758-dbe3-48d7-852c-ae04e326fdc9`), host 2 passed (run `host-2026-11-04T00-20-53.258Z`)
  review-fix: Codex P1 finding 9, E2 records through `recordHypothesis` in `outcome.ts` (lab and host, the host passing `evidence().directory`), so every verdict carries `gestures` and `steps` (the Save dialog's Escape is a step) and a host smoke run is stamped `mode: "smoke"`; the duplicate sampler and the host append path are gone; E3 already used the common recorder; red `vp test --project=harness tests/experiments/downloads-verdicts.test.ts` against today's path: 2 failed (no `gestures`, `steps`, or `mode`), green 2 passed; lab smoke `-g E2.saveAs.prompt` pass, `gestures: 1`, `mode: "smoke"`
  review-fix: Codex P1 finding 2, the host default-location cell writes only into `~/Downloads/RECnRun/poc-downloads-launcher/<run>/`, created exclusively and marked `.recnrun-host-downloads` before the download, every ancestor checked with `lstat` (a symlink is refused), and cleaned in `finally` (every file in the marked folder, then the folders it created); `tests/host/fixtures/default-downloads.ts`; red `vp test --project=harness tests/host/default-downloads.test.ts` against today's path: 8 failed (no marker, a symlinked `RECnRun` and an existing run folder accepted, a `.crdownload` left after a failed write: `ENOENT`), green 8 passed; host `-g location.default` pass 3 samples, `left: []`, `~/Downloads` listing unchanged and no `~/Downloads/RECnRun`
  review-fix: Codex P1 finding 3, a host E2 launch that fails after Chrome started (`Browser.getVersion`, evidence) stops that Chrome before removing its root; `launchOnRoot` (`tests/host/fixtures/host-launch.ts`) also guards `openHostExtension`; red `vp test --project=harness tests/host/host-launch.test.ts` against today's catch: `expected [ 'launch', 'after', 'removeRoot' ] to deeply equal [ 'launch', 'after', 'stop 42', …(1) ]`, green 4 passed; host `chrome.spec.ts` 3 passed
- [i] P1.4 Read in page and offscreen, E3 (lab, host), report `experiments/E3.md`
  red: `npx vitest run tests/poc-file-read.test.ts` (in `apps/extension`) against stubs that register nothing and read nothing: 20 of 20 failed (`expected undefined to deeply equal { ok: true, status: 200, …(1) }`, `expected [] to deeply equal [ false ]`); `vp run test:experiments -- tests/experiments/E3-file-read.spec.ts` (smoke, scratch worktree at `2d27b01` with only the spec): the four sampled hypotheses `fail` with `window.__poc.readFile is not defined in diagnostics.html`, the listing test threw it, "every hypothesis ran" failed (2 failed, 4 passed); new manifest checks against a scratch copy of the builds with `POC_READ_FILE` in the production `background.js`, a `file:///*` content-script match in production and `poc-d0`, and the message stripped from `poc-d1`'s offscreen chunks: 5 checks `not ok`; negative control (scratch worktree, the offscreen handler answering the first content it read for a URL): `E3.offscreen.cache` `fail` "offscreen: the default cache mode saw the change after null polls (no-store: null)" while `E3.page.cache` passed
  green: `npx vitest run tests/poc-file-read.test.ts` 21 passed; `vp run test:unit` 58 files / 474 tests passed on the tree with E2 cherry-picked; `vp run test:extension-manifest` 19 passed; production build byte-identical to `2d27b01` and to E2 alone (`diff -r` empty); `vp run test:experiments -- tests/experiments/E3-file-read.spec.ts` 6 passed in 6.1 s, 3 samples per hypothesis (run `2026-11-03T23-52-59.172Z-849c9445-bf40-4b19-8ff8-aea4d9819ce8`); smoke 6 passed in 2.7 s, same verdicts (run `2026-11-03T23-52-46.073Z-b9a9b7cc-10bf-4055-818f-31b8537a6095`), both on the tree with E2; `vp check`, `vp run deps`, `vp run docs:check` clean
  host: `RECNRUN_HOST_ROOTS=~/Documents/RECnRun/poc-downloads-launcher vp run test:host tests/host/E3-file-read.spec.ts` 6 passed in 45.4 s; run `host-2026-11-04T00-35-50.347Z` (after Codex E3 findings 2 and 4; first round `host-2026-11-03T23-46-55.536Z`, 5 passed): `Chrome/156.0.8078.80`, macOS 27.0.1 (26A434) arm64; 5 cells, 4 sampled 3 times and `E3.directoryListing` unavailable, 0 gestures; afterwards no Chrome on the roots and `roots/` empty
  verdict: E3.page.fetch pass / pass (status 200, the probe's exact bytes)
  verdict: E3.offscreen.fetch pass / pass (the background creates the offscreen document and relays; `XMLHttpRequest` never needed)
  verdict: E3.page.cache pass / pass (the first read after each of the same-length rewrites B, C, D, one poll apart, and the read a poll later return the new bytes; `no-store` never needed)
  verdict: E3.offscreen.cache pass / pass (same; poll 1000 ms read from `folder-watch.ts`)
  verdict: E3.directoryListing unavailable / unavailable ("no dedicated experiment and validated parser (§6.3)"; the folder URL resolves with status 0 and Chrome's 9447-character HTML listing with `addRow(...)` naming both files, page and offscreen alike)
  review-fix: E3 finding 3: CHROMIUM.md group 10 inventories `file_url_loader_factory.cc` (`CreateLoaderAndStart`, `FileURLLoader::Start`, `FileURLDirectoryLoader::Start`) and Blink's raw-resource cache path at `156.0.8078.80` and reconciles them with E3 (cache and directory status agree; errors and `Last-Modified` not measured); E3.md "Prediction check" points at it
  review-fix: Codex E3 finding 2, the cache cells require the first read after each change to return it: the probe goes A→B→C→D one poll (1000 ms, `POLL_MS`) apart and both the immediate read and the one a poll later must show the version just written (`cacheRun` in `tests/experiments/e3-cache.ts`); red `vp test --project=harness tests/experiments/e3-cache.test.ts` against a stub of the earlier rule: 5 failed, the reader stale once after each change gave no problem (`expected [] to deeply equal [ …(3) ]`); green 5 passed; `vp run test:experiments -- tests/experiments/E3-file-read.spec.ts` 6 passed in 42.8 s (run `2026-11-04T00-31-47.791Z-eddf7694-1181-4e7d-b672-0bbce47cbb0f`), smoke 6 passed (run `2026-11-04T00-32-42.268Z-22bcd5cf-4198-4589-a1aa-ebe418548fca`); host run `host-2026-11-04T00-33-17.425Z` (Google Chrome 156.0.8078.80): the 4 sampled cells pass 3 times each; afterwards `roots/` empty and no Chrome on it
  review-fix: Codex E3 finding 4, the host twin lists `E3.directoryListing` and records it `unavailable` with "no dedicated experiment and validated parser (§6.3)" through `recordUnavailable`, reading no folder; red `vp run test:host tests/host/E3-file-read.spec.ts` with the hypothesis listed and no verdict: "every E3 hypothesis left a verdict" failed (`every hypothesis ran`, Expected -1), run `host-2026-11-04T00-33-17.425Z`; green 6 passed, run `host-2026-11-04T00-35-50.347Z`, `E3-host.json` replaced; afterwards `roots/` empty and no Chrome on it
  rule: no content script matches `file:` in any build (`vp run test:extension-manifest`, not a verdict) · lab Google Chrome 157.0.8103.38 on Linux in Docker · files `experiments/verdicts/E3-{lab-full,lab-smoke,lab-versions,host}.json`
  review-fix: E3 finding 1 (`ensureOffscreen` returned while creation was pending). red: `npx vitest run tests/link.test.ts` in `apps/extension` on the old `link.ts`: `a second caller waits for a creation that is still loading` failed `expected true to be false`, `closing waits for a pending creation...` timed out; green: same command, 7 passed
  review-fix: E3 finding 5 (`diagnostics` not forbidden to `views`, `p2p`, `offscreen`). red: throwaway `import "@/diagnostics/report"` in each of the three folders, `vp run deps` reported no violations; green: after the config change the same imports gave 3 violations, removed, `vp run deps` clean; the ARCHITECTURE sentence now names `p2p` and `offscreen` too
  commit: the commit that adds this line

Gate P1: verify · E1–E3 · review

## P2: Discovery without a picker

- [ ] P2.1 Bootstrap of the catalog, E4 (lab, host)
- [ ] P2.2 Registration without a prior choice
- [ ] P2.3 Registry schema and launcher record

Gate P2: verify · E4 · review

## P3: Transport adapter and roles

- [ ] P3.1 Transport interface and Downloads adapter
- [ ] P3.2 Handshake over Downloads, E5 (lab, host)
- [ ] P3.3 Trust and pins
- [ ] P3.4 Roles and command authorization
- [ ] P3.5 Master absent and master back, E6
- [ ] P3.6 Presence cost, E7

Gate P3: verify · E5–E7 · review

## P4: Native launcher

- [ ] P4.1 Script harness (`vp run test:scripts`, ShellCheck, package scan)
- [ ] P4.2 Discovery of Chrome, roots, and profiles, E8 (lab, host)
- [ ] P4.3 Open request and token ack (lab, host)
- [ ] P4.4 Idempotence, timeouts, locks, pause policy, E9
- [ ] P4.5 Commands and autostart
- [ ] P4.6 Package and first run (host)

Gate P4: verify · E8–E9 · host cells · review

## P5: Clean base and graphical cloning on macOS

- [ ] P5.1 Base creation and freeze (CL01, CL02)
- [ ] P5.2 Transactional copy (CL03, CL15)
- [ ] P5.3 Template, bootstrap page, identities (CL04, CL06, CL07)
- [ ] P5.4 Diagnostics page
- [ ] P5.5 Matrix CL05, CL08–CL12, three rounds
- [ ] P5.6 Unpacked code dependency and base update (CL13, CL14)

Gate P5: verify · CL01–CL15 over three rounds · review

## P6: Onboarding with the extension installed only in the Default

- [ ] P6.1 Onboarding flow
- [ ] P6.2 Automatic persistent installation of the base, E10 (CL17)
- [ ] P6.3 V3 end to end (CL16)

Gate P6: verify · CL16, CL17 · review

## P7: Silent and headless execution

- [ ] P7.1 Headless lab runner `vp run test:headless`
- [ ] P7.2 T1–T3 one root, visible and `--no-startup-window`, E11 (lab, host)
- [ ] P7.3 T4–T5 one root, headless attempt, E12 (lab, host)
- [ ] P7.4 T6–T8 separate roots, headless workers, E13 (lab, host); T9 headless on clones

Gate P7: verify · E11–E13 · review

## P8: With and without `chrome.debugger`

- [ ] P8.1 D2 operation
- [ ] P8.2 Variant comparison, E14 (lab, headless, host)
- [ ] P8.3 Clones per variant (host)

Gate P8: verify · E14 · review

## P9: Matrix, metrics, report, and decision

- [ ] P9.1 Soak and repetition (`vp run test:soak`, host soak)
- [ ] P9.2 Mandatory cases mapped
- [ ] P9.3 `RESULTS.md` and document updates

Gate P9: verify · push · pull request updated · review
