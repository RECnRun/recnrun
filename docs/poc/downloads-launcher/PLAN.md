# POC: Downloads rendezvous, native launcher, headless workers, and clean-base cloning

Plan date: 2026-11-03. Source: the Portuguese POC specification of 2026-11-03, kept verbatim in [source-2026-11-03.pt-BR.md](source-2026-11-03.pt-BR.md) ("the source"; `§n` below refers to its sections). This document turns it into phases, tasks, hypotheses, and acceptance criteria that a command can check. Everything that needs a person is in [MANUAL_VALIDATION.md](MANUAL_VALIDATION.md). Progress is tracked in [CHECKLIST.md](CHECKLIST.md). The source names `docs/poc-downloads-headless-plan.md` and `docs/poc-downloads-headless-results.md`; this repository keeps POC documents under `docs/poc/<name>/`, so they are this file and [RESULTS.md](RESULTS.md) (written in P9).

The repository rules ([AGENTS.md](../../../AGENTS.md)) apply to every task: red/green tests, one commit per task, exercise each change, `vp run verify` exits 0 before a phase closes.

## 1. The question and the constraints

Starting from the mesh of PR #19 (pairing through the File System Access API, one WebRTC link per peer), can the extension instances installed by one OS user on one machine find each other and pair with no folder picker, no pairing code, and no write approval, by writing through `chrome.downloads` and reading back through `file://`; can a launcher made only of the OS shell open the closed profiles on demand; do the workers run with no startup window or headless; and does a clean base profile with one installation survive a full copy so clones become workers with no manual step per clone? (§1, §14)

The fixed rule of every variant (§1.1): the extension in the owner's personal `Default` profile is the only master; every other instance is a worker bound to that master; the frozen base is a template; the launcher is the master's helper. A result that drops the master or promotes another profile approves nothing.

| Variant | Allowed preparation                                                                                          | Approval condition                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| V1      | Extension installed in the personal Default; installed by hand in each worker profile; launcher run once     | Workers bind to the Default with no further configuration or pairing gesture                                       |
| V2      | Extension in the Default; one clean worker base installed and configured by hand, frozen; clones full copies | A, B, C are workers of the Default with no reinstall, authorization, or manual provisioning per clone              |
| V3      | Extension in the Default only; the owner runs the launcher script once from the onboarding                   | The base is installed persistently without a hand; clones provision themselves; V2 and the automatic base approved |

Constraints restated as the checks that enforce them. A constraint with no automated check is a manual item, never an assumption.

| Req | Summary (source)                                                                                                          | Enforced by                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Default personal profile is the only master; workers execute; template never announces (§1.1)                             | P3.4 role registry and command authorization tests; P5.4 template block; `tests/browser/hierarchy.spec.ts` rejects worker→worker and worker→master control            |
| R2  | Google Chrome installed, never Electron, Chrome for Testing, Chromium, or `chrome-headless-shell` for approval (§3)       | Lab: `tests/container/runner.checks.mjs` asserts Google Chrome Stable; host: `tests/host` launches `/Applications/Google Chrome.app`; Chromium runs are `diagnostic`  |
| R3  | Delivered runtime needs no Node, Python, Bun, Deno, Playwright, `jq`, HTTP/WebSocket server, Native Messaging, signaling  | `scripts/poc-cross-profile/package.checks.mjs` scans the package for forbidden interpreters and binaries; the Docker lab runs the launcher with `/bin/sh` only (P4.6) |
| R4  | No edit of `Preferences`, `Secure Preferences`, or profile databases; a full copy of a closed base is the hypothesis (§3) | `scripts/poc-cross-profile/clone.checks.mjs`: the copy is byte-identical to the base except the Singleton markers; `grep` of the scripts for those file names fails   |
| R5  | Singleton markers removed only in a new, closed clone; never `LOCK` files, never an occupied root (§3)                    | `clone.checks.mjs` negative controls: an occupied root is refused; the Singleton removal needs the base-closed proof                                                  |
| R6  | No network connection to a host other than loopback (repository rule); `iceServers: []` kept (§2)                         | existing `origin-guard.spec.ts`; `RECNRUN_FORBID_EGRESS=1` in the container; `tests/experiments` egress shim                                                          |
| R7  | Downloads only for presence, discovery, bootstrap, recovery; the DataChannel carries the data (§7)                        | P3.6 counts downloads per hour under load; a business message that produces a download fails `transport-budget.test.ts`                                               |
| R8  | Hierarchy is a protocol fact, not a topology: offerer election never elects the master (§7)                               | P3.4 unit tests with the worker's `profileId` lower than the master's                                                                                                 |
| R9  | Headless means Chrome's own `--headless`, never a minimized window or Xvfb alone (§9)                                     | P7 specs assert `Browser.getVersion` and the absence of a native window through the launcher's process inspection; Xvfb lab runs are labelled `visible`               |
| R10 | D0 final runs have no external CDP client, no DevTools, no `--remote-debugging-*` (§10)                                   | P8 strict cells launch through the launcher with no debugging flag; the harness observes files and process state only (`cdp: false`)                                  |
| R11 | Every gesture counted, per machine, per profile, per base, per clone, after restart (§1, §11.3)                           | `gestures.json` per run, filled by the spec or by the manual record; `scripts/decide.mjs` prints the gesture columns in [RESULTS.md](RESULTS.md)                      |
| R12 | Verify stays green; the headed Docker E2E suite stays; headless is a separate runner (§12)                                | `vp run verify`; `tests/e2e` unchanged apart from the new transport's regressions; `vp run test:headless` separate                                                    |

## 2. Decisions

1. **Branch and base.** This POC lives on `poc-downloads-launcher`, branched from `60989d60e9bc8c7c1de8c7365481a9f8f505a115`, the head of PR #19 (`poc/multi-profile-mesh`). Re-checked on 2026-11-03: the PR is closed, its head is still that SHA, its base `poc/dashboard-only-pairing` at `eca3486`. `master` (`8a7f97b`) does not contain the mesh, so it is not the base (§2). The worktree is `.claude/worktrees/poc-downloads-launcher`. The pull request targets `poc/multi-profile-mesh` so its diff shows only this POC; PR #19 stays closed and untouched. Nothing merges into `master`.
2. **Infrastructure ported from `poc-namespace-sessions`, not rewritten.** P0 cherry-picks, adapting paths: Google Chrome Stable in `Dockerfile.tests` with `/opt/recnrun/versions.json` (commit `a0ecbf1`), `scripts/check-docs.mjs` and `vp run docs:check` (`049a482`), the experiments layer with verdict files, `RECNRUN_EXPERIMENT_SAMPLES=smoke` inside `verify`, and the `scripts/decide.mjs` pattern. Chromium or Chrome for Testing runs are labelled `diagnostic` and never approve a cell (§3).
3. **Two evidence environments, both real Google Chrome.** _Lab_: Google Chrome Stable for Linux in Docker (Ubuntu noble, Xvfb for the visible cells, native `--headless` for the headless cells), automated, in `verify` in smoke mode; it is the "explicitly identified Linux distribution" of §11.1. _Host_: this Mac (macOS 27.0.1, arm64, Google Chrome 156.0.8078.80 at `/Applications/Google Chrome.app`), driven by `vp run test:host` (never part of `verify`), with throwaway `--user-data-dir` roots under `~/Documents/RECnRun/poc-downloads-launcher/`. The owner authorized on 2026-11-03 that Claude drives the host Chrome, including the personal Default profile, with these limits: only the orchestrator (never a subagent) touches the personal Chrome; it is never killed, its data never read or copied, and the only change to it is the extension installed by the owner's `Load unpacked` gesture plus the extension's own storage; subagents launch host Chrome only with the throwaway roots their brief names. Windows: not executed, and no untested PowerShell package is shipped (the repository's exercise rule); the report says "not executed".
4. **Packed distribution is not executed in this round.** No Web Store test channel is available now (owner, 2026-11-03). P1 prepares the zip and records `isAllowedFileSchemeAccess()` for unpacked only; series F and the packed half of H are "not executed", never extrapolated from unpacked (§6.1).
5. **Installing the extension is itself recorded per environment.** Chrome 137 removed `--load-extension` from branded builds (inherited evidence). Lab installs: `Extensions.loadUnpacked` over CDP with `--enable-unsafe-extension-debugging` for diagnostic cells, and a managed-policy force-install from a loopback update server for strict cells (both proved in `poc-namespace-sessions` E0). Host installs for V1: the `Load unpacked` gesture, which the source already counts as the allowed manual install; `Extensions.loadUnpacked` on a throwaway root is the V3 hypothesis for the base (CL17), approved only if the install persists after a full quit and a relaunch without any debugging flag (§3, §8.4).
6. **Build variants from one code base.** `apps/extension/wxt.config.ts` gains POC modes that differ only in the manifest: `poc-d0` (no `debugger`), `poc-d1` (`debugger` declared, never attached), `poc-d2` (`debugger` declared and used), all with `downloads`, `offscreen`, and the file-scheme need; production keeps its guard and `manifest.checks.mjs` checks every variant (§4, §10). The extension id is pinned with a `key` in the POC manifests so clones, variants, and updates compare like with like.
7. **Observation without capability.** Approval cells are observed through what the extension itself writes (a diagnostics page and diagnostics files published through Downloads under `RECnRun/poc/<namespace>/diag/`), the launcher's logs and acks, and process inspection by the harness (`ps`, `lsof`, window enumeration). CDP is an observer in `diagnostic` cells only; every cell that needs an external inspection to diagnose a failure is repeated without it before it is approved (§10, §12). Logs never carry full SDP, cookies, or page data.
8. **Experiments are falsifiable tests with recorded verdicts.** A hypothesis task runs every listed hypothesis and writes `pass`, `fail`, or `unavailable` with the error text, Chrome version, environment (`lab`, `host`), install method, variant, topology, debugger state, and sample counts to `.artifacts/evidence/<run>/verdicts.json`; host runs write under `.artifacts/evidence/host/<run>/`. A failed hypothesis does not fail the task; a hypothesis that did not run does. The 16 answers of §14 are computed by `scripts/decide.mjs` from committed verdicts and the manual records, never written by hand.
9. **Delegation and review.** The orchestrator (this session) owns the plan, the gates, the host cells that touch the personal Default, the Codex reviews, and the push. `plan-implementer` agents in their own worktrees take the other tasks with red/green and one commit per task; the orchestrator cherry-picks onto the branch. The model follows the task: Sonnet for mechanical ports, schema and doc work, and report generation; Opus for Docker, Chrome, launcher, and experiment work; the orchestrator's model only for orchestration and the personal-Default cells. Every brief names the task IDs, the exact files to read (a reading list, not "read the repo"), the files it may change, the Docker commands and throwaway roots it may use, and a cap on hand-backs; an agent never runs `:local` tests against a profile it did not create. Before every phase gate, Codex (`gpt-6.1-sol`, high reasoning effort, `codex exec --ephemeral -s read-only`) reviews the phase's commits; findings are applied with red/green, one commit each, or rejected with a reason, and the full text is saved under `reviews/P<n>.md`.
10. **The launcher is POSIX `sh`, shared by macOS and Linux.** One script set under `scripts/poc-cross-profile/` runs on macOS `/bin/sh` and Debian `/bin/sh` (dash); control files use a fixed line-oriented `key=value` format with a restricted character set, never JSON parsed by the shell; JSON that must be read natively is read with `plutil` on macOS and marked `unavailable` on Linux until a native reader exists (§8.1). ShellCheck runs in Docker over every script. The launcher never executes `eval`, shell text, URLs, or free arguments read from files (§8.1).
11. **Layout of the rendezvous.** The files of §7 under `RECnRun/poc/<namespace>/` are the starting layout; the discovery experiments of P2 may change it, and the plan records the change. Each extension writes only relative paths below its own Downloads root; the launcher is the single writer of `registry.json` (§6.3). Layout fixed by P2.3: a profile publishes `peers/<profileId>/presence.json` in the exact bytes `JSON.stringify` gives a `RegistrationSchema` value (keys `profileId`, `displayName`, `fingerprint`, `createdAt`, `expiresAt`, `namespace`, `boot` in that order, no spaces, no path); `scripts/poc-cross-profile/catalog.sh` reads only that file name in a folder named by a lowercase v4 uuid (hex digits in every group), follows no symbolic link at the file or at any folder below the Downloads root (`RECnRun`, `poc`, the namespace, `peers`, the profile folder), and skips with a logged reason any other key set (the five-key presence included), order, spacing, or trailing byte, a profile id that is not its folder, another namespace, a boot that is not a lowercase v4 uuid, a display name over 64 bytes or with a backslash, quote, control character, or edge space, a time that is not a whole number up to `Number.MAX_SAFE_INTEGER`, an expired presence, and one stamped more than `CLOCK_SKEW_MS` (5 s) ahead of its clock, expiring at or before its creation, or living more than `PRESENCE_TTL_MS` (60 s), the lifetime bounds `RegistrationSchema` also enforces. `registry.json` (`RegistrySchema`, `apps/extension/src/p2p/registry.ts`) is `{ version: 1, namespace, writtenAt, launcher: { boot, fingerprint? }, peers: { <profileId>: { profileId, displayName, fingerprint, root, lastSeenAt, expiresAt, boot } } }` with at most 32 peers, read with `readTolerant`'s rules and a TTL of two presence periods; `root` is the launcher's opaque id for a Downloads root (`r` plus 1 to 3 digits), never a path. A registration (`RegistrationSchema`) is a presence plus `namespace` and the process `boot`, and has no path key. Its `displayName` follows the one contract `RegistrationNameSchema` and `catalog.sh` share (1 to 64 UTF-8 bytes, no `"`, `\`, control character, or edge space, held to the same table `fixtures/display-names.json` on both sides); a stored name outside it is published as `Profile <first four hex digits of the profile id, upper case>` with one log line. The launcher record, kept outside any profile, is blocks of `key=value` lines separated by a blank line, with keys `userDataDir`, `profileDirectory`, `profileId`, `namespace`, `role` (`master`, `worker`, `template`), `masterFingerprint`, `downloadsRoot`, and `root`, and absolute directories in `[A-Za-z0-9._:/ -]` with no `..` segment; `catalog.sh` refuses with exit 65, and rewrites nothing, a record holding any byte other than printable ASCII or a newline, NUL included (it checks the raw bytes before the shell holds them) (`launcher-record.ts` parses and writes it; `catalog.sh` numbers the roots that lack an id and writes the ids back). `catalog.sh` holds `<out-dir>/.catalog.lock` (created with `mkdir`, removed by its exit trap) while it writes, creates its temporary files exclusively under fresh random names, replaces `registry.json` by a rename (a `registry.json` that is a folder or a link exits 73), and a concurrent run exits 75 without writing. Bootstrap fixed by P2.1 ([E4](experiments/E4.md)): to learn a profile's root, the launcher opens `chrome-extension://<id>/bootstrap.html#token=<uuid>` on the profile's root with a fresh lowercase v4 uuid; the page accepts no other fragment, stores the token as the session's `boot` (`session:pocBoot`), and asks its own worker (`POC_PUBLISH_PRESENCE`) to publish its presence at once; the launcher scans the OS default Downloads folder and the record's `downloadsRoot`s for the presence whose `boot` is the token, writes that `profileId` and `downloadsRoot` into the profile's block, and runs `catalog.sh` once per root. Each extension reads `registry.json` only under the root it learned from its own download (`chrome.downloads.search({ id })` of its own item). Signals fixed by P3.1: a profile leaves its half of a pairing for one peer at `peers/<from>/offer-<to>.json` or `peers/<from>/answer-<to>.json`, a `StampedSignalSchema` value (`kind`, `pairingId`, `profileId`, `to`, `expiresAt`, `code`, plus the writer's `boot` and a `sequence`, a safe integer of at least 1 that each writer raises as `max(last + 1, now)`), replaced in place (`conflictAction: "overwrite"`, `saveAs: false`) and at most `MAX_CODE_LENGTH` characters; the RECnRun folder's files carry the same `boot` (presence) and `boot` plus `sequence` (signals). A reader takes only the signal addressed to it, unexpired, from a peer the catalog lists (under its own root once the catalog lists it), and only in its sender's current boot, the boot of that sender's latest presence; it drops a lower sequence of the same boot and file. The offscreen document reads these files through `file://` with `cache: "no-store"` and writes and erases them only through the background's relay (`rendezvous-relay.ts`), which refuses `presence.json` and every path that is not one of this profile's signal files; the presence stays the alarm's.
12. **Earlier POCs are inputs.** Section 3 lists what PR #19 and `poc-namespace-sessions` measured. Their failed hypotheses are not repeated as hypotheses; their mechanisms are reused.
13. **Trust model (P3.3).** The profiles of a namespace are extensions installed by the same OS user, and initial trust comes through the local channel: a profile pins a peer's DTLS certificate fingerprint (`apps/extension/src/p2p/pins.ts`, `local:peerPins`, source `pairing-code`, `local-channel`, or `manual`) only once the handshake has proved it, never because a presence, `registry.json`, or a code announced it, since those files are writable by anyone running as that user. A pin is never replaced by a file: a code or signal announcing another certificate for a pinned profile is refused before any connection, a presence announcing one gets no offer, and a link proving another certificate is closed. Any manual approval of a peer is a gesture and is counted where the experiments count gestures (the `steps` of each sample; `tests/experiments/outcome.ts` writes the largest count as the verdict's `gestures` field), never left out of the usability result (§7). Two limits follow from the rule. The DTLS certificate renews about every 29 days (`certificate-store.ts`), and every peer that pinned the old one refuses the renewed one; the owner decided on 2026-11-04 (Gate P3) for a continuity proof, not a manual re-pin: a profile's identity is a long-lived, non-extractable WebCrypto signing key (`identity-key.ts`, IndexedDB), the pin is that key, and every presence, signal, and handshake carries the current DTLS fingerprint signed by it, so a renewed certificate verifies against the same pin with no gesture and with the peer offline during the renewal; the DTLS handshake still proves the certificate, the signature proves it belongs to the pinned identity, and a fingerprint without a valid signature is refused as a mismatch (P3.3 follow-up, `apps/extension/tests/identity-key.test.ts`, `tests/browser/certificate-renewal.spec.ts`). Forget keeps the pin, so a forgotten profile pairs again only with the same certificate. The master is identified by the Default's recorded identity and certificate (P3.4, `apps/extension/src/p2p/roles.ts`, `local:role`): each worker binds it once their pair is linked, from the certificate it pinned at pairing, and the master records the workers it bound the same way (`local:boundWorkers`), through the local channel in the Downloads builds and, in the folder build, the end-to-end fixture `bindHierarchy` standing in for the launcher record and the P5.3 bootstrap; never from a `role` field, the topology, a directory name, or profile id order.

## 3. Inherited evidence

Measured before this plan; each line gives the implication.

- **PR #19 (Chromium in Docker, headed, five `--user-data-dir` roots).** Cases A–D, G, H met; E partial (the session is stored only in the executing profile); F (Remote Run) not met. Links came up in about 0.4 s over a host UDP candidate; a quitting browser dropped its link in about 3 s through the heartbeat (ICE alone took about 6 s); re-pairing worked. Two profiles of one root were never automated. Implication: the transport and the handshake are a regression baseline (P0.2), and "one root, several profiles" (T1–T5) is new ground.
- **PR #19 design.** Identity per installation (`profileId` UUID in `storage.local`), persistent DTLS certificate in IndexedDB with pinned fingerprints, one `RTCPeerConnection` per peer in the offscreen document with `iceServers: []`, full ICE before publishing, offerer chosen by the lower `profileId`, `MEMBERS`/`SIGNAL`/`INVITE` mesh messages, presence TTL 60 s renewed at 30 s and polled every second, explicit Disconnect/Forget pauses. Implication: P3 keeps all of it and adds roles on top; it does not rewrite the mesh as a star (§7).
- **Branded Chrome and extensions (`poc-namespace-sessions`, Google Chrome 156 in Docker, 2026-11-02/03).** `--load-extension` is gone from branded builds; `Extensions.loadUnpacked` works with `--enable-unsafe-extension-debugging` over the port or the pipe; a managed-policy force-install from a loopback CRX works, but `Target.attachToTarget` is "Not allowed" unless `DeveloperToolsAvailability: 1`; a policy-installed extension shows no `debugger` infobar (`debugger_api.cc`, `suppress_warning` for policy locations). Implication: decision 5; D2's infobar behaviour on the host is a manual record.
- **CDP clients confound.** Playwright's `connectOverCDP` auto-attaches every worker, which changed worker lifecycle results in E2–E4 there. Implication: decision 7; approval cells run with `cdp: false`.
- **xdotool/scrot on Xvfb are brittle** (no feedback channel, paint timing, a `BadWindow` on noble). Implication: the lab uses them for Chrome dialogs only, with retries bounded in the fixture (`tests/e2e/fixtures/native-dialogs.ts` already exists at the base).
- **Shared Git hooks.** `.vite-hooks/pre-push` of the main checkout runs for every worktree and runs `vp run verify` when the pushed branch lacks `scripts/git-hooks/pre-push.mjs` (this base lacks it). GitHub closes an idle SSH connection during that run: push with `GIT_SSH_COMMAND="ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=20"` in the foreground.

## 4. How acceptance is checked

- Every acceptance criterion names a test file and the `vp run` command that runs it. A criterion with no automated check does not close a task; it goes to [MANUAL_VALIDATION.md](MANUAL_VALIDATION.md).
- A phase closes when its tasks are `[x]` in [CHECKLIST.md](CHECKLIST.md), `vp run verify` exits 0 on the branch, the host cells the phase owns are recorded (a `host:` line per cell with the run id), and the checklist records a Codex code review of the phase's commits (model `gpt-6.1-sol`, high reasoning effort) with the findings applied and the ones rejected, each with a reason (checklist resume protocol, step 6).
- Layers:

| Layer       | Files                                                                                                                                                                                                 | Command                                                    | In `verify` | Added in |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------- | -------- |
| Unit        | `{apps,packages}/*/tests/*.test.ts`                                                                                                                                                                   | `vp run test:unit`                                         | yes         | exists   |
| Component   | `*.browser.test.ts(x)` in Vitest Browser Mode                                                                                                                                                         | `vp run test:components`                                   | yes         | exists   |
| End-to-end  | `tests/e2e/*.spec.ts`: headed Chromium on Xvfb, the mesh regressions, labelled `diagnostic`                                                                                                           | `vp run test:e2e`                                          | yes         | exists   |
| Browser     | `tests/browser/*.spec.ts`: Google Chrome Stable in Docker, extension installed, fixture, observer                                                                                                     | `vp run test:browser`                                      | yes         | P0.3     |
| Experiments | `tests/experiments/*.spec.ts`: hypotheses that write verdicts; smoke mode inside `verify`                                                                                                             | `vp run test:experiments`                                  | smoke       | P0.3     |
| Headless    | `tests/headless/*.spec.ts`: Google Chrome Stable with `--headless` in Docker, launcher-started                                                                                                        | `vp run test:headless`                                     | smoke       | P7.1     |
| Host        | `tests/host/*.spec.ts`: the installed Google Chrome on this Mac, throwaway roots, launcher-started                                                                                                    | `vp run test:host -- <spec>`                               | no          | P0.5     |
| Scripts     | `scripts/poc-cross-profile/*.checks.mjs`: catalog writer (P2.3), launcher units, package scan, clone rules, ShellCheck (P4.1)                                                                         | `vp run test:scripts`                                      | yes         | P2.3     |
| Soak        | one-hour sessions, 20 cold starts, 50 reconnections (§11.3)                                                                                                                                           | `vp run test:soak` (Docker) and `vp run test:host -- soak` | no          | P9.1     |
| Container   | `tests/container/*.checks.mjs`: image reports Google Chrome ≥ 156, versions file (P0.2); lab runs on the internal `recnrun-tests` network with no route out and filters its own egress to `lo` (P1.0) | `vp run test:container`                                    | yes         | P0.2     |
| Docs        | `scripts/check-docs.mjs`: links and anchors resolve; generated tables current                                                                                                                         | `vp run docs:check`                                        | yes         | P0.1     |

- Coverage thresholds (80/80/80/75), Knip, jscpd, lint caps, and the architecture rules of the base apply to new code. Shell scripts are tested through `node --test` harnesses that run them in Docker and, for macOS, through `vp run test:host`.
- [RESULTS.md](RESULTS.md) embeds the output of `scripts/decide.mjs` over `experiments/verdicts/` and `manual/*.json`; `docs:check` fails when it is stale.

## 5. Target layout

```text
apps/extension/src/p2p/rendezvous-transport.ts   the small signaling-transport interface (available, publish, watch, discover, clean)
apps/extension/src/p2p/folder-store.ts            FSA adapter, unchanged, the control
apps/extension/src/p2p/downloads-rendezvous.ts    Downloads + file:// adapter (paths, probe, catalog reader, tolerant JSON reader)
apps/extension/src/p2p/registry.ts                registration and registry.json schemas, the catalog reader (P2.3)
apps/extension/src/p2p/launcher-record.ts         the launcher record format: parser and serializer, used by tests and diagnostics (P2.3)
apps/extension/src/background/downloads-publisher.ts   chrome.downloads calls, typed messages from the offscreen, persisted results
apps/extension/src/p2p/roles.ts                   role model: master | worker | template, the worker's bound master, the master's bound workers (P3.4)
apps/extension/src/p2p/authorization.ts           message classes and command authorization by verified identity (P3.4)
apps/extension/src/background/launcher-requests.ts     open requests and acks the extension exchanges with the launcher
apps/extension/src/offscreen/folder-watch.ts      watcher over the selectable transport (no overlapping polls)
apps/extension/src/entrypoints/bootstrap/         bootstrap.html: #token=<uuid> becomes the boot and publishes at once (P2.1); operation token, instance id, master binding (P5.3)
apps/extension/src/entrypoints/diagnostics/       the diagnostics page of §8.4 (no secrets)
apps/extension/wxt.config.ts                      poc-d0 | poc-d1 | poc-d2 modes; production guard kept
scripts/poc-cross-profile/                        catalog.sh (P2.3), recnrun-launcher.sh, lib/*.sh, launchd/, systemd/, package/, *.checks.mjs
tests/browser, tests/experiments, tests/headless, tests/host, tests/e2e/fixtures/profiles.ts (per topology)
docs/poc/downloads-launcher/                      PLAN, CHECKLIST, MANUAL_VALIDATION, CHROMIUM.md, experiments/E*.md, reviews/, RESULTS.md
```

`apps/extension/src/p2p/folder-rendezvous.ts` keeps its schemas, TTL, and announce/publish/look/clean semantics; the rendezvous logic is separated from disk access behind `rendezvous-transport.ts`. Nothing returns a fake `FileSystemDirectoryHandle` (§4). Bases, clones, and their data stay out of Git; the repository holds scripts, bootstrap, diagnostics, sanitized configuration, and reports (§8.4).

## 6. Phases

Task IDs are stable; the checklist uses them. "Accept" lines are the automated checks. "Host" lines name cells run on this Mac with `vp run test:host` and recorded in the checklist. "Manual" lines name items in [MANUAL_VALIDATION.md](MANUAL_VALIDATION.md). "Hypotheses" lines list what an experiment task must run; each gets a verdict.

### P0: Base, lab, baseline, and Chromium inventory (§5, §13 step 1)

Goal: the branch builds and verifies at its base; Google Chrome Stable runs in Docker and on the host under the harness; the mesh regressions pass again; every Chrome hypothesis has a pinned source reference.

- **P0.1 Plan documents and `docs:check`.** This plan, the checklist, the manual items, the verbatim source. Port `scripts/check-docs.mjs` (`poc-namespace-sessions` `049a482`), wired as `vp run docs:check` inside `verify`. Add the POC to the `docs/` list of `AGENTS.md` and a row to `docs/POCS.md`.
  Accept: `node --test scripts/check-docs.checks.mjs` passes; `vp run docs:check` exits 1 on a broken link in a scratch copy and 0 on the branch.
- **P0.2 Baseline of the base.** Record SHA, Chrome and OS versions, Vite+ version. Run `vp run verify` on `60989d6` and record the counts (the PR reported 450 unit/component and 66 E2E; not assumed). Port Google Chrome Stable into `Dockerfile.tests` with `versions.json` (`a0ecbf1`), keep the Playwright image's Chromium for `tests/e2e`.
  Accept: `vp run test:container` asserts Google Chrome ≥ 156 and the versions file; `vp run test:e2e` passes the mesh specs (`cross-profile-*.spec.ts`, `folder-pairing.spec.ts`) unchanged, recorded as the regression baseline.
- **P0.3 Browser and experiments layers on branded Chrome.** `tests/browser/fixtures/chrome.ts` launches Google Chrome Stable headed on Xvfb with a throwaway root; the loader installs the test build with `Extensions.loadUnpacked` (diagnostic) or the policy force-install (strict, `cdp: false`); the verdict writer, the evidence folder, and smoke mode come from `poc-namespace-sessions`; the CDP client accepts only `ws://` endpoints on the loopback (the egress guard of the lab itself is P1.0). Experiment E0 re-records both install methods on this base and this Chrome.
  Accept: `tests/experiments/E0-install.spec.ts` writes a verdict per method; `tests/browser/mesh-two-profiles.spec.ts` pairs two roots over the existing FSA transport on Google Chrome Stable (the regression of §5 item 2 on the branded browser); `vp run verify` runs the experiments in smoke mode.
- **P0.4 Chromium inventory.** `docs/poc/downloads-launcher/CHROMIUM.md`: for each hypothesis of §5, the file, function, permalink at the tag of the installed Chrome (`156.0.8078.80`; the lab's version recorded next to it), what it says, and the experiment that tests it: initial file access of packed and unpacked extensions (`extension_service_unittest.cc` `DefaultPackedFileAccess`/`DefaultUnpackedFileAccess` and the loader), `StartupBrowserCreator::ShouldLoadProfileWithoutWindow` and `ProcessCmdLineImpl`, `ChromeProcessSingleton::NotifyOtherProcessOrCreate` and the Mac/Linux `ProcessSingleton`, `downloads_api.cc` destination determination and `conflictAction`, extension service-worker startup on profile load and `onStartup`, headless mode and extension startup, `file://` loading from extension contexts, `chrome.debugger` attach/detach and worker lifetime. `main` is never cited as the installed behaviour (§5).
  Accept: `vp run docs:check` resolves every link; each later experiment's report cites its CHROMIUM.md entry.
- **P0.5 Host runner.** `tests/host/fixtures/host-chrome.ts` finds `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, creates roots under `~/Documents/RECnRun/poc-downloads-launcher/roots/<run>/`, installs the build with `Extensions.loadUnpacked` (diagnostic) or waits for the owner's `Load unpacked` (strict), and writes evidence under `.artifacts/evidence/host/<run>/`. `vp run test:host` runs Playwright on the host against that fixture and is excluded from `verify` and from the Docker runner; it refuses to start when `RECNRUN_HOST_ROOTS` is unset, and it never names a root outside that folder.
  Accept: `tests/host/chrome.spec.ts` reads `Browser.getVersion` with product `Chrome/156.0.8078.80`; `tests/host/roots.test.ts` (Node) proves the refusal of a root outside the folder; `scripts/test-container.mjs` rejects `test:host` as a Docker target.
- **P0.6 Namespace and evidence schema.** Valibot schemas for `verdict`, `gestures`, `cell` (environment, install, variant, topology, debugger, roots, Downloads layout, operation, clone, template state), shared by the lab, the host runner, and `scripts/decide.mjs`.
  Accept: `tests/experiments/schema.test.ts`; a verdict without an environment or an install method is refused.

Gate P0: `vp run verify` exits 0; baseline counts and Chrome versions recorded in the checklist; `CHROMIUM.md` committed.

### P1: Downloads write and `file://` read, in isolation (§6.1, §6.2, §13 step 2)

Goal: the extension writes a file through `chrome.downloads` to a relative destination, learns the real absolute path, and reads it back through `file://` in a page and in the offscreen document, on both environments, with every edge case of §6.2 measured. Default master plus one visible worker, D0, no launcher, no FSA grant.

- **P1.0 Lab egress guard.** Codex review of P0 (finding 2): the lab promised no egress and had only the loopback-only CDP client. `scripts/test-container.mjs` runs every Docker test target, `verify` included, on `recnrun-tests`, an internal Docker bridge network it creates once: the container keeps `lo` and `eth0` (WebRTC host candidates need a non-loopback interface, and `--network none` broke every mesh test), the image's entry adds an on-link default route with `NET_ADMIN` (a page's WebRTC binds its host candidate to the default-route address, so the component tests gathered nothing without it), the entry filters the container's own egress to `lo` because `--internal` still reaches the gateway and peer containers (Codex P1 finding 1: iptables rejects everything else at once and accepts only mDNS multicast, whose loop copy resolves a page's host candidate; a `tc` egress drop on `eth0` keeps that copy and ARP in), DNS and every route out still fail, and the image is built before the run, so nothing in the run needs the network. `tests/browser/no-egress.spec.ts` proves it from Node (DNS, a TCP connect to a public address, to the gateway, and to a peer address on the subnet, and the mDNS loop with the `eth0` drop), from a page, and from the extension's service worker, with a loopback positive control.
  Accept: `tests/container/runner.checks.mjs` asserts that every task runs on `recnrun-tests` and refuses a network that routes out; `tests/container/image.checks.mjs` asserts the entry's route, the exact iptables accept list, and the `tc` drop; `tests/browser/no-egress.spec.ts` sees `EAI_AGAIN` for DNS, `EHOSTUNREACH` at once for public, gateway, and peer addresses, `EPERM` for a UDP send to the peer, `ERR_NAME_NOT_RESOLVED` or an equivalent failure from a page and from the service worker, and the mDNS loop copy with the `eth0` frame dropped; a scratch run without the filter is the negative control.
- **P1.1 POC build variants.** `wxt.config.ts` modes `poc-d0`, `poc-d1`, `poc-d2` with `downloads`, `offscreen`, the pinned `key`, the `file:///*` host permission (MV3 reads `file://` from an extension page only with it and the file-access toggle, found by E1), and the entrypoints of section 5; production guard untouched; `manifest.checks.mjs` checks each variant's permissions and entrypoints and that production has none of them (§4). `apps/extension/src/config/origins.ts` enables the mesh in the POC modes without touching production.
  Accept: `vp run test:extension-manifest` passes for the four builds and fails in a scratch copy where production gains `downloads`.
- **P1.2 Clean install and the file-scheme state.** Experiment E1, lab and host.
  Hypotheses: after an unpacked install with no gesture, `chrome.extension.isAllowedFileSchemeAccess()` is false (CHROMIUM.md `DefaultUnpackedFileAccess`) and a `fetch("file://…")` from the extension page fails with a recorded error; after the owner toggles "Allow access to file URLs" it succeeds; revoking it breaks the read with a clear diagnostic; a reinstall or an update with new permissions prompts again. Packed install: `unavailable` (decision 4).
  Accept: `tests/experiments/E1-file-access.spec.ts` (lab: the toggle is driven at `chrome://extensions` through xdotool, labelled as a gesture) and `tests/host/E1-file-access.spec.ts`; every verdict carries `gestures`. Manual: M-P1.a (personal Default install and toggle).
- **P1.3 Probe write and real path.** Experiment E2.
  Hypotheses: `chrome.downloads.download({ url: blobOrDataUrl, filename: "RECnRun/poc/<ns>/probe.json", saveAs: false, conflictAction: "overwrite" })` completes; `DownloadItem.filename` is absolute; the path converts to a `file://` URL that reads back the same bytes; overwrite of the same destination 100 times never produces `(1)`-style names; empty content, spaces, Unicode, and URL-encoding characters round-trip; a cancelled or interrupted download leaves `.crdownload` that the reader tolerates; "Ask where to save each file" turns the write into a prompt (recorded as a gesture, driven with xdotool in the lab); a custom Downloads location and a redirected one are learned from `filename`, never guessed from `$HOME/Downloads`; the shelf/bubble, notifications, and history entries are recorded as visible traces.
  Accept: `tests/experiments/E2-downloads-probe.spec.ts` and the host twin; the tolerant reader's unit tests (`downloads-rendezvous.test.ts`: absent file, partial JSON, old version, file being replaced, temporary errors; the last valid publication stands until its TTL).
- **P1.4 Read in page and offscreen.** Experiment E3.
  Hypotheses: `fetch(file://)` works in the extension page and in the offscreen document; if one differs, an alternative web API of the offscreen context is tried and the working one documented; cache behaviour of repeated reads (a changed file is seen within one poll); a `file://` directory listing is `unavailable` unless a dedicated experiment and a validated parser exist (§6.3).
  Accept: `tests/experiments/E3-file-read.spec.ts` with a verdict per context; no content script reads `file://`.

Gate P1: `vp run verify` exits 0; E1–E3 reports under `experiments/`; the answer to §14 question 1 for "write and read back" and question 2 for unpacked are computable.

### P2: Discovery without a picker (§6.3, §13 step 3)

Goal: each extension finds the catalog and the launcher finds every participant's real Downloads root, first with one common root, then with different roots, with no path typed by a person in the approved flow.

- **P2.1 Bootstrap of the catalog.** Experiment E4, lab then host.
  Hypotheses: (a) common root: each extension learns its own root from the probe (P1.3) and reads `RECnRun/poc/<ns>/registry.json` there; the launcher, the single writer, enumerates `peers/*/presence.json` natively and publishes the catalog; (b) different roots: the launcher learns a root from the registration the extension publishes during an opening with a bootstrap token (`bootstrap.html#token`), scanning the OS default Downloads folder and the roots it already knows; (c) the launcher reads `download.default_directory` of each candidate profile's `Preferences` with a native reader (`plutil` on macOS; `unavailable` on Linux); (d) a manually configured path, as a diagnostic control that fails the "no configuration" criterion.
  Accept: `tests/experiments/E4-discovery.spec.ts` with one verdict per hypothesis and per root layout; `scripts/poc-cross-profile/catalog.checks.mjs` proves the single writer and the restricted file names; no `chrome.downloads.search` of one profile is read as another's history.
- **P2.2 Registration without a prior choice.** `peers.ts` starts the Downloads variant without an FSA state; `folder.resume()` no longer requires a previously recorded participation; `start.ts` separates peer initialization from opening or focusing the dashboard, tested on `onInstalled`, `onStartup`, and a profile loaded into a Chrome already open (§4).
  Accept: `apps/extension/tests/peers-start.test.ts`; `tests/browser/silent-start.spec.ts` (no dashboard page opens, the presence appears, and a 30 s `chrome.alarms` alarm, which restarts a stopped worker, rewrites it at least three times in two TTLs with no CDP client on the worker, every gap at most one TTL; CHROMIUM.md group 12).
- **P2.3 Registry schema and launcher record.** The launcher's record of `(userDataDir, profileDirectory) → profileId`, namespace, role, master fingerprint, kept outside any profile; the extension's registration payload is small and restricted (§6.3, §8.1).
  Accept: unit tests of the schemas; `catalog.checks.mjs` refuses a registration with a free-form path.

Gate P2: `vp run verify` exits 0; E4 report; §14 question 3 computable, including the limits for custom roots and closed profiles.

### P3: Transport adapter and roles (§7, §1.1, §13 step 4)

Goal: the handshake and the mesh checks of PR #19 run over the Downloads adapter, FSA preserved as the control, with the Default as the only master and command authorization enforced in code, Default plus one worker and Default plus four workers.

- **P3.1 Transport interface and Downloads adapter.** `rendezvous-transport.ts` (available, publish done, watch, discover, clean); `folder-store.ts` implements it unchanged in behaviour; `downloads-rendezvous.ts` implements it with the probe, the tolerant reader, and the layout of §7; `folder-watch.ts` serializes polls and keeps renewal, backoff, and recovery.
  Accept: `apps/extension/tests/rendezvous-transport.test.ts` runs the same contract suite against both adapters; `folder-pairing.spec.ts` (FSA) still passes.
- **P3.2 Handshake over Downloads.** Experiment E5, lab and host, Default plus one worker then Default plus four.
  Hypotheses: offer and answer files reach the recipient within the poll period; ICE complete before publishing is kept; a boot generation and a sequence distinguish a previous run's presence and signals; simultaneous arrival, duplicate offer/answer, expired or corrupt file, clock change, peer quitting during ICE, both restarting, read cache, reconnection with no dashboard, a fifth profile arriving when the four others have no extension page open (§7).
  Accept: `tests/experiments/E5-handshake.spec.ts` (one verdict per trial) and `tests/browser/mesh-downloads.spec.ts` (the mesh regressions of `cross-profile-mesh.spec.ts` on the new transport, FSA spec kept).
- **P3.3 Trust and pins.** Pinned fingerprints are never replaced because a new catalog or presence appears; a certificate announced in a writable file does not authenticate a first meeting by itself; the documented trust model is "extensions installed by the same OS user, initial trust through the local channel"; any manual approval of a peer is a counted gesture (§7).
  Accept: `apps/extension/tests/pins.test.ts`; `tests/browser/forged-sender.spec.ts` (the forged-sender regression of PR #19 on the Downloads transport).
- **P3.4 Roles and command authorization.** `roles.ts`: the Default's identity and certificate are the master; each worker persists its binding; `template` blocks announce, discovery, and work; commands are authorized by the sender's verified identity, never by topology, `role` fields, directory names, or UUID order; the offerer election never elects the master; responses, status, heartbeat, and signaling relays stay bidirectional (§1.1, §7).
  Accept: `apps/extension/tests/roles.test.ts` (worker→worker, worker→master, forged `role=master`, clone with a `Default/` subdirectory, worker `profileId` lower than the master's); `tests/browser/hierarchy.spec.ts` (a worker's control command over a valid DTLS link is refused; its results reach the master).
- **P3.5 Master absent and master back.** Workers never promote themselves or accept another controller while the Default is closed; work in progress follows the executor's explicit policy with state preserved; the same Default recovers binding, status, and results without re-execution; tested separately from a worker restart (§1.1).
  Accept: `tests/browser/master-restart.spec.ts`; `tests/experiments/E6-master-absent.spec.ts`.
- **P3.6 Presence cost.** Count downloads per hour with five participants at the current TTL (about 600/hour expected); hypotheses to cut writes: launcher-published presence, DataChannel heartbeat for liveness, presence renewal only while no link exists; `transport-budget.test.ts` fails when a business message produces a download (§7, §11.3).
  Accept: `tests/experiments/E7-presence-cost.spec.ts` with the counts per variant.

Gate P3: `vp run verify` exits 0; E5–E7 reports; `vp run test:soak` not yet required (P9).

### P4: Native launcher (§8.1–§8.3, §13 step 5)

Goal: one shell package per supported OS (macOS and Linux in this round) that finds Chrome and the roots, binds `profileId` to `(userDataDir, profileDirectory)`, keeps the catalog, opens registered profiles on request, waits for a token ack, is idempotent, and has start/status/stop/autostart commands.

- **P4.1 Script harness.** `vp run test:scripts` runs `node --test scripts/poc-cross-profile/*.checks.mjs` in Docker with `/bin/sh` (dash) and ShellCheck; the same checks run on the host through `vp run test:host -- scripts` with macOS `/bin/sh`. `package.checks.mjs` scans the package for forbidden runtimes (R3).
  Accept: the harness fails on a scratch script that calls `jq`, `node`, `python`, or `eval`.
- **P4.2 Discovery of Chrome, roots, and profiles.** Default locations per OS; candidates with the extension installed; the `profileId` binding automated through the extension's registration (the dashboard name is never assumed to be `Profile 2`); same-root profiles handled separately from distinct roots (§8.1, §8.2).
  Hypotheses (E8): Chrome closed; only Default open; a secondary profile open; several roots; fixed extension id; unpacked builds at different paths; extension updated; extension removed.
  Accept: `discovery.checks.mjs` over fixture trees; `tests/experiments/E8-launcher-discovery.spec.ts` (lab) and the host twin.
- **P4.3 Open request and token ack.** Requests hold registered identifiers and enumerated options only, inside operations authorized by the master; the launcher opens only registered profiles (never creates one by a typo); it waits for an ack carrying the attempt token, the identity, and the current boot; PID, exit code, or a window are not proof (§8.1).
  Accept: `requests.checks.mjs` (a request with a free argument or an unknown profile is refused; an ack without the token is ignored); `tests/browser/launcher-open.spec.ts` (lab: the launcher opens a second root and the ack arrives).
- **P4.4 Idempotence, timeouts, locks, pause policy.** Two runs do not open a window storm; duplicate requests do not start copies; timeout, backoff, launcher lock, restart, voluntary exit; an executor paused by Disconnect/Forget is not relaunched without an explicit policy (§8.1).
  Accept: `lifecycle.checks.mjs`; `tests/experiments/E9-launcher-lifecycle.spec.ts`.
- **P4.5 Commands and autostart.** `start`, `status`, `stop`, `autostart on|off` with a user LaunchAgent (macOS) and `systemd --user` (Linux; background execution documented where unavailable); no manual configuration file editing on the default path (§8.1).
  Accept: `commands.checks.mjs` (plist and unit generated and validated with `plutil -lint` and `systemd-analyze verify` where present); the Docker lab runs `start`/`status`/`stop`. Manual: M-P4.a (autostart after an OS login on the Mac).
- **P4.6 Package and first run.** One directory per OS with a single entry point, the prepared extension bundle, and `README` naming the exact first command and the OS prompts; no build on the colleague's machine (§8.3).
  Accept: `package.checks.mjs`; the host record of the first run on this Mac with the gestures counted.

Gate P4: `vp run verify` exits 0; host cells P4.2, P4.3, P4.6 recorded; §14 questions 4 and 8 computable for V1.

### P5: Clean base and graphical cloning on macOS (§8.4, CL01–CL15, T9, §13 step 6)

Goal: a clean worker base with one installation, frozen; full copies A and B, later C, become workers of the personal Default without reinstall, with their own identity and certificate, provisioned before any announcement.

- **P5.1 Base creation and freeze.** `create-base`: a new root under `~/Documents/RECnRun/poc-downloads-launcher/base-v1/`, opened with the real Chrome and `--profile-directory=Default`, path confirmed at `chrome://version`, no import, no sync; the extension installed (V2: `Load unpacked`, a counted gesture); only used capabilities configured (file access, Downloads); `pocSetting = 'base-v1'`; `templateMode = true`; full quit proved by process inspection, not by a closed window (§8.4).
  Accept: `base.checks.mjs` (refuses an existing root; refuses to freeze while a process holds the root); host cell CL01, CL02 with gestures.
- **P5.2 Transactional copy.** `create-clone`: `ditto` to a temporary destination, verification, publication by rename, refusal of existing destinations, no symlinks or hard links, Singleton markers removed only in the new closed clone, interrupted copies never opened (§8.4, R4, R5).
  Accept: `clone.checks.mjs` (byte comparison against the base except the markers; interrupted copy refused; occupied destination refused; `LOCK` files untouched); host cells CL03, CL15.
- **P5.3 Template, bootstrap page, identities.** `templateMode` blocks discovery, announce, and work from the first service-worker activation, including `onInstalled`; `bootstrap.html#…` receives the instance id, the master binding, and the operation token, validates them against the operation record, generates the clone's own certificate (the template holds no working certificate), clears only transient peer state, persists the provisioning, leaves template mode, emits the ack correlated to the `operationId`, then announces; repeated bootstrap is idempotent; a conflicting identity fails with a diagnostic (§8.4).
  Accept: `apps/extension/tests/template.test.ts`, `bootstrap.test.ts`; `tests/browser/template-silence.spec.ts` (a template never announces; a forged `role=master` stays worker); host cells CL04, CL06, CL07.
- **P5.4 Diagnostics page.** Extension id and version, instance identity, `bootId`, `templateMode`, role, master identity, effective permissions, transport state and last error, peer identity; no secrets (§8.4).
  Accept: `tests/browser/diagnostics.spec.ts`; component test of the page.
- **P5.5 Matrix CL05, CL08–CL12.** Default personal plus A and B in three roots (CL05); isolation of cookie, localStorage, IndexedDB, and extension storage between A and B (CL08); effective permissions exercised per clone (CL09); master→A/B commands and A/B→master results with sequence, nonce, identity, worker→worker control refused (CL10); close and reopen B (CL11); C created later from the original base (CL12). Three rounds with new destinations; copy time, physical and logical space, time to ready, time to link measured (§8.4).
  Accept: `tests/host/clones.spec.ts` drives the launcher and the diagnostics files; the orchestrator runs the cells where the personal Default is the master (decision 3) and records them with run ids.
- **P5.6 Unpacked code dependency and base update.** CL13: the unpacked path removed temporarily, failure reproduced, recovery after restore, id re-checked after a move; CL14: `base-v2` through a maintenance copy, old clones untouched (§8.4).
  Accept: host cells CL13, CL14 with the diagnostics page's record.

Gate P5: `vp run verify` exits 0; CL01–CL15 recorded over three rounds; §14 questions 11, 12, 14 computable.

### P6: Onboarding with the extension installed only in the Default (CL16, CL17, V3, §13 step 7)

Goal: the onboarding in the personal Default prepares the base automatically, counting the owner's single script run, and the installation persists after a full quit and a relaunch with no provisioning client.

- **P6.1 Onboarding flow.** The Default's dashboard offers "Prepare workers": base path, clone count, `operationId`; the launcher reports success, error, and pending actions; completion by real acks correlated to the `operationId`, never by a timer; the base's administrative ack is separate from discovery (§8.4).
  Accept: unit tests of the onboarding state machine; `tests/browser/onboarding.spec.ts` (lab, with a lab master root).
- **P6.2 Automatic persistent installation of the base.** Experiment E10, host (CL17).
  Hypotheses: the launcher starts the base root with `--remote-debugging-pipe --enable-unsafe-extension-debugging`, the extension's own page in the Default (or the launcher) sends `Extensions.loadUnpacked`, Chrome quits fully, relaunches with no debugging flag, and the extension is still installed and enabled; the same after a second relaunch; the policy force-install as a second mechanism where a user-level policy path exists on macOS; any mechanism that needs a flag removed from the installed Chrome is `unavailable`.
  Accept: `tests/host/E10-base-install.spec.ts` with one verdict per mechanism and the persistence check without any client; `scripts/poc-cross-profile/provision.checks.mjs`.
- **P6.3 V3 end to end.** With the extension installed by hand only in the personal Default: the owner runs the launcher once, the base is created and installed by P6.2, frozen, A and B cloned and provisioned, acks reach the Default's onboarding (CL16).
  Accept: host cell recorded by the orchestrator with the gesture columns (Default, machine, base, per clone).

Gate P6: `vp run verify` exits 0; CL16, CL17 recorded; §14 question 13 computable. This phase does not block V1 or V2's independent results (§13).

### P7: Silent and headless execution (§9, T1–T9, §13 step 8)

Goal: measure, per topology, whether workers start the extension and keep the offscreen document alive with `--no-startup-window` and with Chrome's native `--headless`, in one root and in separate roots, with the Default always a normal Chrome window.

- **P7.1 Headless lab runner.** `vp run test:headless`: Google Chrome Stable in Docker with `--headless` (the spelling the installed version accepts, from CHROMIUM.md), started by the launcher, observed through files and `ps`; a separate Playwright project; the headed E2E suite unchanged (§12).
  Accept: `tests/headless/chrome.spec.ts` proves the mode (no window, `Browser.getVersion` in a diagnostic run only); `tests/container/runner.checks.mjs` knows the new target.
- **P7.2 T1–T3: one root, visible and `--no-startup-window`.** Experiment E11, lab and host.
  Hypotheses: the launcher loads the right worker profile of a root whose Default is open and the worker connects (T1); workers started with `--no-startup-window` initialize the extension and keep the offscreen document without a window (T2); cold start from the launcher, Default first then workers, acks and coordination without promotion (T3); worker start without `showDirectoryPicker`, `requestPermission`, dashboard, PiP, or user activation; default name without "Save name" (§9).
  Accept: `tests/experiments/E11-one-root.spec.ts`; `tests/host/E11-one-root.spec.ts`.
- **P7.3 T4–T5: one root, headless attempt.** Experiment E12.
  Hypotheses: a second process with `--headless` for a worker of a root in use by the Default is refused, handed off, or isolated (CHROMIUM.md singleton entry); several headless workers of one root at cold start; conflicts quantified, never solved by swapping the master or running the Default headless (§9).
  Accept: `tests/experiments/E12-one-root-headless.spec.ts` with the observed lock/handoff behaviour; `tests/host` twin.
- **P7.4 T6–T8: separate roots, headless workers.** Experiment E13, V1 roots first, then V2/V3 clones (T9 headless).
  Hypotheses: pre-installed extensions run under the Default's command in independent headless processes (T6); coordination, discovery, and reconnection persist with the Default's dashboard closed and no worker page visible (T7); a root alternated between visible and headless keeps identity, certificate, cookies, and permissions (T8); remote tabs, navigation, and a response carrying the worker's unique marker on a static test page; focus and PiP recorded as not applicable, separate from tab operations (§9).
  Accept: `tests/headless/E13-separate-roots.spec.ts`; `tests/host/E13-separate-roots.spec.ts`; same clone never open visible and headless at once.

Gate P7: `vp run verify` exits 0; E11–E13 reports; §14 questions 5 and 6 computable.

### P8: With and without `chrome.debugger` (§10, §13 step 9)

Goal: the viable modes and topologies run in D0, D1, and D2, built from the same code, on clean installs and on updates, with detach, failure, and ten-minute post-detach survival measured, and no external client in the D0/D1 approval runs.

- **P8.1 D2 operation.** The Default requests; the worker attaches to its own test tab, sends `Runtime.enable`, `Page.enable`, and a `Runtime.evaluate` that returns the page marker, returns the result, detaches; attach before and after the DataChannel; deliberate detach, closed tab, navigation, attach on an occupied or restricted target; the mesh survives debugger failure (§10).
  Accept: `tests/browser/debugger-d2.spec.ts`; unit tests of the D2 message schemas.
- **P8.2 Variant comparison.** Experiment E14: each viable topology in D0, D1, D2; clean first install and update as separate series; ten minutes of connection after detach; the D0/D1 approval runs with `cdp: false` and no DevTools; a cell that passes in D2 and fails in D0 is "debugger-dependent" (§10, §11.2). The question behind the axis (owner, 2026-11-03) is whether the extension works headed and headless with and without the `chrome.debugger` API, whose attach normally shows the "is debugging this browser" infobar; so every D2 cell also records the infobar: in headed cells whether it appears after the attach and whether a policy force-install hides it (seen on Linux in `poc-namespace-sessions`, re-measured here on Chrome 156 and on macOS), in headless cells `not applicable` together with proof that the attach and the commands still work without any infobar UI. D1 cells record the install-time permission warning only.
  Hypotheses: `E14.d0.<topology>`, `E14.d1.<topology>`, `E14.d2.<topology>` (link, Downloads rendezvous, commands, ten minutes after detach), `E14.infobar.headed` (shown after attach with the manual or `loadUnpacked` install), `E14.infobar.policy` (hidden with the policy install), `E14.infobar.headless` (`not applicable`, attach works).
  Accept: `tests/experiments/E14-debugger-axis.spec.ts`, `tests/headless` and `tests/host` twins; verdicts carry `debugger: d0|d1|d2` and `externalClient: false`; the infobar observation comes from the Xvfb capture of the lab (`tests/browser/fixtures/x-display.ts`) and a screenshot of the throwaway root on the host.
- **P8.3 Clones per variant.** Base versions for D0, D1, D2 and the inheritance of permissions in each clone; a build swap that prompts in every clone is not "no gesture per clone" (§10).
  Accept: host cells recorded with gestures.

Gate P8: `vp run verify` exits 0; E14 report; §14 question 7 computable.

### P9: Matrix, metrics, report, and decision (§11, §14, §13 step 10)

- **P9.1 Soak and repetition.** `vp run test:soak` (Docker) and `vp run test:host -- soak`: 20 cold starts of the best variant per environment; 50 reconnections of one worker; link after boot ack P95 ≤ 15 s and open-to-ack P95 ≤ 30 s measured (exceeding is recorded, never masked); one-hour session with five participants and no extension page open, D0 against D2; channel drop detected within 10 s; CPU, memory, reads, downloads, bytes per hour, disk growth; windows and prompts counted apart from clicks (§11.3).
  Accept: the soak writes `metrics.json`; `scripts/decide.mjs` reads it.
- **P9.2 Mandatory cases.** Every row of §11.2 mapped to a spec or a host cell in section 7 below; the rows that need the owner are manual items.
  Accept: `scripts/decide.mjs` lists a row with no verdict as "not executed".
- **P9.3 RESULTS.md.** The 16 answers of §14, the classification of V1, V2, V3 per OS and distribution (`approved`, `approved with an added requirement`, `failed`, `not executed`), the cloning criteria table, the gesture columns, the limits with their CHROMIUM.md source and experiment, and the exact user steps. Generated block from `scripts/decide.mjs`, checked by `docs:check`. Updates to `POC-CROSS-PROFILE-WEBRTC.md`, `docs/POCS.md`, `docs/ARCHITECTURE.md`, and the manifest guard where the results change what they describe (§13).
  Accept: `vp run docs:check`; every "observed" line cites a spec or a host run id.

Gate P9: `vp run verify` exits 0; the branch pushed; the pull request against `poc/multi-profile-mesh` updated with the decision summary. No release, no change to `master`, no PR integration (§13).

## 7. Matrices

### 7.1 Topologies (§9)

| ID  | Topology                                                                  | Task         | Environments                |
| --- | ------------------------------------------------------------------------- | ------------ | --------------------------- |
| T1  | One root, Default master plus one to four visible workers                 | P7.2         | lab (Xvfb), host            |
| T2  | One root, Default normal, workers `--no-startup-window`                   | P7.2         | lab, host                   |
| T3  | Cold start, Default normal then same-root workers without a window        | P7.2         | lab, host                   |
| T4  | Root in use by the Default, second headless process for a worker          | P7.3         | lab, host                   |
| T5  | Cold start, Default normal, several same-root workers requested headless  | P7.3         | lab, host                   |
| T6  | Default in its root, two or four headless workers in distinct roots       | P7.4         | lab (`test:headless`), host |
| T7  | Default with its dashboard closed, all workers headless in distinct roots | P7.4         | lab, host                   |
| T8  | One worker root alternated visible and headless, sequentially             | P7.4         | lab, host                   |
| T9  | Frozen base, clones A/B/C in own roots, personal Default as controller    | P5, P6, P7.4 | host (macOS first)          |

### 7.2 Series (§11.1)

| Series | Distribution      | Topology               | Debugger                  | Downloads                       | This round                     |
| ------ | ----------------- | ---------------------- | ------------------------- | ------------------------------- | ------------------------------ |
| A      | Unpacked, clean   | T1                     | D0                        | same default location           | lab + host                     |
| B      | Unpacked          | T2, T3                 | D0, D1, D2                | same default location           | lab + host                     |
| C      | Unpacked          | T4, T5                 | D0; D2 if viable          | same default location           | lab + host                     |
| D      | Unpacked          | T6, T7                 | D0, D1, D2                | same default location           | lab + host                     |
| E      | Unpacked          | T8                     | D0, D2                    | location persistence            | lab + host                     |
| F      | Packed            | best of A–E            | D0, D2                    | initial `file://` state         | not executed (decision 4)      |
| G      | Best proven       | Default + four workers | D0, D2                    | different and custom roots      | lab + host                     |
| H      | V2 base, unpacked | T9, CL01–CL15          | D0 first, then D1/D2      | inherited permissions and paths | host; packed half not executed |
| I      | V3                | T9, CL16, CL17         | D0/D1 strict; D2 separate | base provisioning               | host                           |
| J      | Approved clones   | T6/T7/T8 in own roots  | D0, D1, D2                | Downloads and FSA separately    | host, after H                  |

OS rows: Linux = Google Chrome Stable in Docker (Ubuntu noble; Xvfb cells labelled `visible`, `--headless` cells `headless`); macOS = this Mac; Windows = not executed.

### 7.3 Cloning cases (§8.4)

| ID   | Case                                          | Task       |
| ---- | --------------------------------------------- | ---------- |
| CL01 | New base                                      | P5.1       |
| CL02 | Single installation and configuration         | P5.1       |
| CL03 | Copy of a closed base                         | P5.2       |
| CL04 | First opening of A/B                          | P5.3       |
| CL05 | Personal Default plus A plus B                | P5.5       |
| CL06 | Provisioning                                  | P5.3       |
| CL07 | Three restarts                                | P5.3       |
| CL08 | Isolation                                     | P5.5       |
| CL09 | Effective permissions                         | P5.5       |
| CL10 | Default→A/B and A/B→Default                   | P5.5, P3.4 |
| CL11 | Close and reopen B                            | P5.5       |
| CL12 | C created later                               | P5.5       |
| CL13 | Unpacked code unavailable                     | P5.6       |
| CL14 | Base copy update                              | P5.6       |
| CL15 | Interrupted copy or occupied destination      | P5.2       |
| CL16 | Onboarding in the Default                     | P6.1, P6.3 |
| CL17 | Automatic persistent installation of the base | P6.2       |

### 7.4 Mandatory cases (§11.2)

| Case                                       | Task       | Automation            |
| ------------------------------------------ | ---------- | --------------------- |
| V1: install and wait, launcher prepared    | P4.3, P7.2 | lab + host            |
| V2: base prepared, create and open a clone | P5.2, P5.3 | host                  |
| V3: start the onboarding in the Default    | P6.3       | host (orchestrator)   |
| Template or unprovisioned clone            | P5.3       | lab + host            |
| Close dashboards and every extension page  | P3.2, P7.4 | lab + host            |
| Leave only the Default open                | P4.3       | lab + host            |
| Chrome closed at start                     | P7.2 (T3)  | lab + host            |
| Default plus one to four workers           | P3.2, P3.4 | lab + host            |
| Worker tries to control another profile    | P3.4       | lab                   |
| Clone uses `Default/` or forges master     | P3.4, P5.3 | lab + host            |
| Close and reopen the master                | P3.5       | lab + host            |
| Restart an executor                        | P3.2, P5.5 | lab + host            |
| Restart the launcher                       | P4.4       | lab + host            |
| Kill an executor abruptly                  | P3.2       | lab + host            |
| Sleep/wake or network change               | P9.1       | host; sleep is M-P9.a |
| Explicit Disconnect/Forget                 | P3.2, P4.4 | lab                   |
| Different Downloads roots                  | P2.1       | lab + host            |
| `file://` permission revoked               | P1.2       | lab + host            |
| Corrupt or expired file, forged sender     | P3.2, P3.3 | lab                   |
| Normal Chrome already uses the root        | P7.3       | lab + host            |
| D2 passes, D0 fails                        | P8.2       | lab + host            |
| Visible ↔ headless                         | P7.4 (T8)  | lab + host            |
| Start after OS login                       | P4.5       | M-P4.a                |

## 8. Working rules specific to this plan

- A hypothesis that fails is recorded with its cause and the next hypothesis is tried; a hypothesis that was not executed blocks the task. A tool defect found by a cell becomes the first red test of its fix (§14); a Chrome limit is documented with its CHROMIUM.md source and the experiment, never worked around by changing the goal.
- Every verdict names its environment, install method, variant, topology, debugger state, and whether an external client was attached. Results are reported as "Google Chrome <version> on Linux in Docker" or "Google Chrome <version> on macOS <version>"; Windows and packed cells are "not executed".
- Host roots live under `~/Documents/RECnRun/poc-downloads-launcher/`; a test refuses any other root. The personal Chrome is never killed; `pkill`-style commands name a PID the launcher recorded, never a process name.
- Negative controls (file access off, wrong path, expired answer, forged recipient, launcher absent, occupied root, inherited certificate, announcing template, repeated or conflicting bootstrap, interrupted copy, live base, non-persistent CDP install) are scratch mutations, never committed as behaviour (§12).
- The headed Docker E2E suite is not changed to headless; `tests/headless` is the separate runner. When a result shows the headed rule rests on an outdated limit, the rule's justification is updated with the evidence and the UI tests that need windows stay (§12).
- Nothing is pushed to `master`; the branch is pushed and its pull request against `poc/multi-profile-mesh` updated after each phase gate. PR #19 is never reopened or merged (§2).
