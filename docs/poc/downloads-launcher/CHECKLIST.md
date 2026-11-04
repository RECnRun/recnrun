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
- [i] P1.1 POC build variants `poc-d0`, `poc-d1`, `poc-d2`
  red: `vp run test:extension-manifest` with the new checks before the config change: `poc-d0/d1/d2 declare their permissions...` fail, actual `[ 'storage', 'tabs' ]` vs expected `[ 'storage', 'tabs', 'offscreen', 'downloads', 'debugger' ]`
  green: `vp run test:extension-manifest` 11 passed (production + three POC builds); `origins.test.ts` 8 passed; production and test manifests byte-identical before and after (empty `diff`); negative control in a scratch worktree, production with `downloads`: 2 checks fail; pinned id `omllgeochjfpkjbkpcgjmnnbncdpiedd`
  commit: cherry-picked from agent/p1-variants 45da8e7 (Add the POC build variants with a pinned extension id); SHA recorded at the gate
  follow-up: `host_permissions: ["file:///*"]` added to the POC variants after E1 showed `fetch(file://)` needs it besides the toggle; red `vp run test:extension-manifest` 3 POC checks fail (`host_permissions` undefined), green 11 passed, production manifest byte-identical (Give the POC variants the file host permission)
- [i] P1.2 Clean install and the file-scheme state, E1 (lab, host), report `experiments/E1.md`
  red: `vp run test:experiments -- tests/experiments/E1-file-access.spec.ts` before the build wiring: `The poc-d0 build has no manifest.json at /workspace/apps/extension/.output/chrome-mv3-poc-d0; run vp run --no-cache extension#build:poc-d0.`; first round (`223b800`, P1.1 build with no `file:` host permission): `E1.unpacked.toggleOn` fail "after the toggle on, fileSchemeAccess true, fetch failed (TypeError: Failed to fetch)"; toggle control in a scratch worktree (`toggleSample` expecting `fileSchemeAccess === !target`): `E1.unpacked.toggleOff` verdict `fail` "after the toggle off, fileSchemeAccess false, fetch failed (TypeError: Failed to fetch)"; schema control with `gestures` removed: `Invalid verdicts at 0.gestures: Invalid key: Expected never but received "gestures"`; `cdp-client.test.ts` with the detach handler removed: `expected Error: Browser.getVersion: no reply withi… to be an instance of CdpDetachedError`
  green: with the P1.1 follow-up (`host_permissions: ["file:///*"]`): `vp run test:experiments -- tests/experiments/E1-file-access.spec.ts` 9 passed in 20.7 s, 3 samples per hypothesis (run `2026-11-03T23-23-38.584Z-5df92a62-1563-4349-9204-dc247ed597b9`); smoke (`RECNRUN_EXPERIMENT_SAMPLES=smoke`) 9 passed in 7.3 s, same verdicts (run `2026-11-03T23-24-21.445Z-55ef947e-d163-4a99-b6ad-a4eddd796449`); `vp run test:unit` passed; `vp check`, `vp run deps`, `vp run docs:check` clean
  host: `RECNRUN_HOST_ROOTS=~/Documents/RECnRun/poc-downloads-launcher vp run test:host tests/host/E1-file-access.spec.ts` 10 passed in 32.7 s; run `host-2026-11-03T23-24-49.000Z`: `Chrome/156.0.8078.80`, macOS 27.0.1 (26A434) arm64; 6 cells sampled 3 times (gestures 0, 2, 3, 2, 0, 1, all `cdp-click`), 3 `unavailable`; afterwards no Chrome on the roots and `roots/` empty
  verdict: E1.unpacked.default fail lab and host (access true and the fetch reads the probe with no gesture; pref `newAllowFileAccess: true`, flags 32806) · E1.unpacked.toggleOff pass lab and host (2 gestures: Developer mode, toggle) · E1.unpacked.toggleOn pass lab and host (3 gestures; the read follows the toggle) · E1.unpacked.reinstall fail lab and host (the revoke survives quit, relaunch, and reinstall; the toggled install still runs after a relaunch, flags 38) · E1.unpacked.noHostPermission pass lab and host (control with `host_permissions` removed: access true, fetch `TypeError: Failed to fetch`) · E1.unpacked.noDeveloperMode pass lab and host (toggle with Developer mode off disables the build, `unsupportedDeveloperExtension`) · E1.policy.default pass lab (strict, location 7, no access pref; fetch unavailable without a channel), unavailable host (no system plist) · E1.packed unavailable lab and host (decision 4, M-P9.c) · E1.gesture.default unavailable host (M-P1.a) · lab Google Chrome 156.0.8078.79 on Linux in Docker, xdotool every click · files `experiments/verdicts/E1-{lab-full,lab-smoke,lab-versions,host}.json`
  commit: `223b800` first round and harness · the commit that adds this line (rerun on the fixed build)
- [i] P1.3 Probe write and real path, E2 (lab, host)
  red: `npx vitest run tests/downloads-rendezvous.test.ts` against a stub `readTolerant` that kept nothing: `Tests  30 failed | 2 passed (32)`; `npx vitest run tests/downloads-publisher.test.ts` against a listener that ignored every message: `Tests  6 failed | 1 passed (7)`, `expected 'ignored' to match object { ok: true, result: { id: 1 } }`; `vp run test:experiments -- tests/experiments/E2-downloads-probe.spec.ts -g E2.write.completes` with the diagnostics page lacking `__poc`: verdict fail, `window.__poc.probe is not defined on the diagnostics page`; negative control in a scratch worktree, `readTolerant` accepting partial JSON: `Tests  3 failed | 29 passed (32)`
  green: `vp run test:unit` 56 files / 450 tests passed; `downloads-rendezvous.test.ts` 32 and `downloads-publisher.test.ts` 8 passed; `vp run test:experiments -- tests/experiments/E2-downloads-probe.spec.ts` full 11 passed in 1.2 min (run `2026-11-03T23-36-54.382Z-9c60631f`), smoke 11 passed in 24 s (run `2026-11-03T23-44-32.508Z-db206fa7`), Google Chrome 157.0.8103.38 on Linux; `vp run test:extension-manifest` 11 passed, production `background.js` has no `downloads.download` and the production build is byte-identical to `ae5a735`
  host: `vp run test:host -- tests/host/E2-downloads-probe.spec.ts` run `host-2026-11-03T23-38-29.899Z`, Google Chrome 156.0.8078.80, macOS 27.0.1 (26A434) arm64: 10 cells (9 run, `E2.saveAs.prompt` unavailable), 14 passed with `chrome.spec.ts`; afterwards no launched Chrome, no root left, nothing under `~/Downloads/RECnRun`
  verdict: E2.write.completes pass / pass
  verdict: E2.filename.fileUrl pass / pass
  verdict: E2.overwrite.100 pass / pass (one name, no `(1)`, 3 to 4 ms and 73 to 97 ms per write)
  verdict: E2.content.roundTrip fail / fail (`?` refused with `Invalid filename`; `%` became `_`)
  verdict: E2.interrupted.crdownload pass / pass (an auto-restarted download takes the URL's name)
  verdict: E2.saveAs.prompt pass, 1 gesture / unavailable (native dialog on macOS, no xdotool; M-P1 manual not scheduled)
  verdict: E2.location.custom pass / pass
  verdict: E2.location.default pass / pass
  verdict: E2.traces pass / pass
  verdict: E2.path.absoluteRefused pass / pass
  commit: the commit that adds this line (Probe Downloads writes and their real path in experiment E2)
- [i] P1.4 Read in page and offscreen, E3 (lab, host), report `experiments/E3.md`
  red: `npx vitest run tests/poc-file-read.test.ts` (in `apps/extension`) against stubs that register nothing and read nothing: 20 of 20 failed (`expected undefined to deeply equal { ok: true, status: 200, …(1) }`, `expected [] to deeply equal [ false ]`); `vp run test:experiments -- tests/experiments/E3-file-read.spec.ts` (smoke, scratch worktree at `2d27b01` with only the spec): the four sampled hypotheses `fail` with `window.__poc.readFile is not defined in diagnostics.html`, the listing test threw it, "every hypothesis ran" failed (2 failed, 4 passed); new manifest checks against a scratch copy of the builds with `POC_READ_FILE` in the production `background.js`, a `file:///*` content-script match in production and `poc-d0`, and the message stripped from `poc-d1`'s offscreen chunks: 5 checks `not ok`; negative control (scratch worktree, the offscreen handler answering the first content it read for a URL): `E3.offscreen.cache` `fail` "offscreen: the default cache mode saw the change after null polls (no-store: null)" while `E3.page.cache` passed
  green: `npx vitest run tests/poc-file-read.test.ts` 21 passed; `vp run test:unit` 58 files / 474 tests passed on the tree with E2 cherry-picked; `vp run test:extension-manifest` 19 passed; production build byte-identical to `2d27b01` and to E2 alone (`diff -r` empty); `vp run test:experiments -- tests/experiments/E3-file-read.spec.ts` 6 passed in 6.1 s, 3 samples per hypothesis (run `2026-11-03T23-52-59.172Z-849c9445-bf40-4b19-8ff8-aea4d9819ce8`); smoke 6 passed in 2.7 s, same verdicts (run `2026-11-03T23-52-46.073Z-b9a9b7cc-10bf-4055-818f-31b8537a6095`), both on the tree with E2; `vp check`, `vp run deps`, `vp run docs:check` clean
  host: `RECNRUN_HOST_ROOTS=~/Documents/RECnRun/poc-downloads-launcher vp run test:host tests/host/E3-file-read.spec.ts` 5 passed in 9.8 s; run `host-2026-11-03T23-46-55.536Z`: `Chrome/156.0.8078.80`, macOS 27.0.1 (26A434) arm64; 4 cells sampled 3 times, 0 gestures; afterwards no Chrome on the roots and `roots/` empty
  verdict: E3.page.fetch pass / pass (status 200, the probe's exact bytes)
  verdict: E3.offscreen.fetch pass / pass (the background creates the offscreen document and relays; `XMLHttpRequest` never needed)
  verdict: E3.page.cache pass / pass (the first read after a same-length rewrite sees it: 0 polls, 1 to 3 ms; `no-store` never needed)
  verdict: E3.offscreen.cache pass / pass (same; poll 1000 ms and TTL 60 s read from `folder-watch.ts` and `folder-rendezvous.ts`)
  verdict: E3.directoryListing unavailable / not run ("no dedicated experiment and validated parser (§6.3)"; the folder URL resolves with status 0 and Chrome's 9447-character HTML listing with `addRow(...)` naming both files, page and offscreen alike)
  review-fix: E3 finding 3: CHROMIUM.md group 10 inventories `file_url_loader_factory.cc` (`CreateLoaderAndStart`, `FileURLLoader::Start`, `FileURLDirectoryLoader::Start`) and Blink's raw-resource cache path at `156.0.8078.80` and reconciles them with E3 (cache and directory status agree; errors and `Last-Modified` not measured); E3.md "Prediction check" points at it
  rule: no content script matches `file:` in any build (`vp run test:extension-manifest`, not a verdict) · lab Google Chrome 157.0.8103.38 on Linux in Docker · files `experiments/verdicts/E3-{lab-full,lab-smoke,lab-versions,host}.json`
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
