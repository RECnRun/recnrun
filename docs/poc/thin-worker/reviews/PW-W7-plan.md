# Reviews of the W7 plan draft

Two read-only reviews of the owner's draft `RECnRun-POC-W7-Remote-Interaction.md` against edcb5681, 2026-11-07: Codex (gpt-6.1-sol, effort high) and Claude Opus (effort high). Both found it viable as a lab POC and not executable as written. [W7-PLAN.md](../W7-PLAN.md) adopts their fixes: lab-local paths, shared admission with jobs, a dedicated interactive tab bound to the W6 pipeline, a start signed over both DTLS fingerprints and `bootId`, a 3 s lease, per-frame metadata and `loaderId` epochs, a closed key table, close-the-tab cleanup, drag variant A first, and four slices with no baseline full run.

Where they differ, the plan takes: Opus's reuse of the runner admission queue (no ledger entry, as Codex asks), Codex's worker-issued challenge plus Opus's fingerprint binding, and at least 30 latency samples per mode.

## Codex (verbatim)

**Verdict: revise before implementation.** W7 is a plausible GO-LAB-ONLY experiment, but its integration assumptions and several safety gates need correction. Confirmed clean worktree, branch `poc-w6-visual-observability`, HEAD `edcb5681`.

1. **Blocker — W6 cannot currently observe the proposed interactive tab.** `runner.js` creates, attaches, binds, then destroys each job tab. `observe.js`, its checker, master discovery, and frame admission require that running job’s identity. W7 simultaneously forbids an active job. **Fix:** introduce a worker-owned interactive target lifecycle and explicit capture/session ownership; adapt both ends of admission. Do not manufacture a paused job or ledger entry to satisfy W6.

2. **Blocker — authentication is achievable, but absent as a link property.** W1 authenticates worker→master; W4/W6 verify individual master signatures. There is no mutual HELLO; W6’s signed request contains no link binding, and subsequent requests do not verify their arrival link against the session. Offscreen-generated `linkId` is not exposed for signing. **Fix:** have the worker issue a fresh challenge bound to its actual peer, both DTLS fingerprints, boot, and identity; verify the pinned master’s signed response. Associate `input.v1` with that exact peer, reject duplicate channels, and check transport-derived identity on start, renew, and every input. Revoke on replacement; never migrate leases. Extension IDs are identical across roots, and worker keys are ephemeral: retain explicit lab-only identity limitations.

3. **Blocker — separate queues would recreate admission races.** The existing job lock covers validation, ledger lookup, claiming, and persistence through one serialized admission queue. `current()` becomes non-null later and is not that lock. **Fix:** share admission between jobs and interaction through STARTING, LIVE, and cleanup. Preserve ledger replay responses without executing mutations; release ownership only after cleanup or target disposal.

4. **Major — frame identity and coordinate mapping need an actual contract.** W6 drops screencast geometry metadata; its envelope has image dimensions, document epoch, sequence, and observation session. Preserve geometry per frame and bind `captureId` to boot/session/target/document plus a bounded worker-side record. Reject fabricated IDs and delayed dispatch after navigation or resize. Chrome 157’s `page_handler.cc::BuildScreencastFrameMetadata` reports DIP dimensions; `input_handler.cc::ScaleFactor` applies browser/pinch zoom. JPEG pixels, DIP, and CSS coordinates are not interchangeable; viewport input must not add document scroll offsets. [Page source](https://raw.githubusercontent.com/chromium/chromium/157.0.8103.38/content/browser/devtools/protocol/page_handler.cc), [Input source](https://raw.githubusercontent.com/chromium/chromium/157.0.8103.38/content/browser/devtools/protocol/input_handler.cc). **Fix:** calibrate contain/letterboxing, resize, DPR, zoom, and both capture paths. Add fresh capture on demand: static W6 pages otherwise exceed the proposed 1.5-second freshness limit indefinitely.

5. **Major — ordered delivery does not serialize asynchronous handlers.** Reliable `input.v1` preserves arrival order within that channel; it provides neither ordering against `visual.v1` nor protection from overlapping awaited handlers. **Fix:** serialize local dispatch, bound queue depth/age, revalidate immediately before effects, and prioritize revocation over queued input. Cleanup must bypass stale-frame/expired-lease rejection, release keys/buttons, cancel composition/drag, and disable interception. A crashed service worker loses its in-memory pressed state; use close/recreate recovery rather than assuming detach resets everything. Bound disconnect cleanup independently of ICE detection and the 30-second lease.

6. **Major — drag A/B is justified; cancellation differs.** Chrome 157’s `InputHandler::StartDragging` supports mouse-driven drag internally when interception is disabled; enabling interception emits string `DragData`. B still needs a genuine source drag and explicit destination events, not invented payloads. `CancelDragging` returns immediately without an internal drag, so intercepted B needs explicit cancellation/source-end verification. [Input implementation](https://raw.githubusercontent.com/chromium/chromium/157.0.8103.38/content/browser/devtools/protocol/input_handler.cc). **Fix:** test source `dragend`, destination data, cancellation, and reset between variants. Actual headed/headless success remains **[unsure]** until exercised.

7. **Major — origin confinement is overstated.** Top-level origin checks do not confine cross-origin iframe input, form destinations, popups, downloads, or network effects. An overlay receiving the click is normal hit-testing, not necessarily a detectable protocol error. W4 explicitly deferred destination/network confinement. **Fix:** define the narrower boundary and defer unsupported iframe guarantees; retain compromised-site risk. Focus emulation is appropriate: `EmulationHandler::SetFocusEmulationEnabled` increases capturer count with `stay_hidden=false`; it does not establish native OS focus. [Chrome 157 source](https://raw.githubusercontent.com/chromium/chromium/157.0.8103.38/content/browser/devtools/protocol/emulation_handler.cc).

8. **Major — scope and paths import Phase 1 prematurely.** `apps/worker` and `packages/worker-protocol` are future architecture, not existing lab modules. **Fix:** use lab-local `worker-extension/interaction*.js`, closed schema/check modules following existing validators, and `site/interaction*.js`; keep docs in English under thin-worker. Reuse the HTTPS master stand-in and existing target server. Nested fixture URLs require serving changes. Also extend `playwright.config.ts`: its headless regex currently excludes every proposed W7 filename. Reuse W6 fragmentation/admission; its LIVE cap is 5 fps, so 20–30 fps requires an explicit worker-local policy change.

9. **Minor — latency claims exceed the measurement design.** One master monotonic clock is correct, but ACK or the next frame does not identify changed content; rAF is a presentation proxy, not proof of physical display. **Fix:** decode a unique fixture action marker, bind it to the displayed frame, and report that limitation.

N1–N7, N9–N10, N12, N14–N15 test boundaries **if adversarial inputs produce asserted zero effects**, including authentic requests transplanted between links. N8 tests congestion/availability; reduce it to one saturated-visual input check. N11 mixes capability discovery with security; retain PT text in I2, defer native IME/shortcuts. Split N13’s overlay semantics from iframe policy. N15 needs a latched worker stop that survives attempted renewal/restart.

Use four slices, each with the same targeted Docker command red then green:

1. Mutual link proof, shared admission, lease: N1–N4/N9/N14.
2. Interactive target, W6 admission, mapping, click: I1/N6–N7.
3. Text, wheel, pressed-state recovery: I2–I4/N5/N10/N15.
4. Drag A/B, isolation/congestion smoke, latency, regressions, final `verify`.

Skip redundant full baseline runs; reuse recorded W6 evidence. Start with 20–30 latency samples per mode, reporting raw distribution without confident p99 claims. Defer extensive benchmarks, F6, PWA, real signalling, and macOS checks to owner/Phase 1.

Exercised: read-only repository/plan review and Chrome 157 source inspection. No edits, browsers, tests, or Docker; runtime viability remains untested.

## Opus (verbatim)

### W7 plan review (read-only; worktree head edcb5681)

**Verdict:** viable as lab POC, but not executable as written: wrong base, nonexistent modules, W6's job-coupling of capture, and three technical claims that Chromium 157 source contradicts or settles.

#### 1. Fit with existing code

- **Blocker** — Base `poc-thin-worker`@9150de8e: that branch is at d51a4b81 and has no W6 code. Fix: branch from `poc-w6-visual-observability`@edcb5681.
- **Blocker** — W6 capture/observe only work while a job runs: `observe.js` `live()`/`liveError` and `observe-check.js` `jobError` require `current()`; `capture.bind(target, jobId)` only comes from `runner.run`; frames carry `jobId` and `site/admission.js` checks it. A "dedicated interact tab" has no job → the W6 pipeline is not reusable as is. Fix: admit `INTERACT_START` through the same `admission` queue + `running` claim of `runner.js` (N1–N3 for free), create the tab `active:false`, attach, focus emulation, `bind(target, interactId)`; W6's OBSERVE_*/master admission then work unchanged with `jobId=interactId`.
- **Major** — Proposed `apps/worker`, `packages/worker-protocol` (Valibot), `apps/website` components, HTTPS fixture, `docs/poc/remote-input/*` (6 files): does not fit the lab; new packages trigger the ARCHITECTURE/dependency-cruiser rules. Fix: lab-local like W6: `worker-extension/{input-schema,input-check,interact,pressed-state}.js` (closed hand-written checkers like `observe-schema.js`), `site/{input-client,remote-view}.js`, `w-interact*.spec.ts` + node `interact.test.ts`; docs `docs/poc/thin-worker/W7-PLAN.md` + `RESULTS.md#w7` + CHECKLIST + `reviews/PW-W7.md`. `target-server.ts` (HTTP loopback) is enough; `localhost` vs `127.0.0.1` are already distinct sites for OOPIF if needed.
- **Minor** — `captureId = streamGeneration+counter`: the envelope already has `bootId/epoch/frameSeq/sessionEpoch`. Reuse it.

#### 2. Technical correctness (Chromium 157)

- **Major — mapping.** Screencast `deviceWidth/Height` = surface DIP, not CSS px (`page_handler.cc` `BuildScreencastFrameMetadata`). `dispatchMouseEvent` multiplies x/y by `ScaleFactor()` = browser zoom × CSS zoom × page scale (`input_handler.cc:1551–1574`). Metadata has no browser zoom → `xCss = xNorm·deviceWidth/(zoom·pageScale)`. Fix: read zoom via `Page.getLayoutMetrics` once per epoch/size change, or pin 100% and assert. `capture.js` `keep()` drops the metadata today; screenshot-fallback frames never have it; first frame after resize is swallowed (`page_handler.cc` ~1921). Fix: carry metadata per frame; refuse input aimed at screenshot frames with `STALE_FRAME` (ask for a new frame).
- **Major — pageEpoch/stale.** `epoch` only moves on `Page.frameNavigated` (after commit). Fix: epoch = main-frame `loaderId`, and re-read `Page.getFrameTree` (url+loaderId) before every down/key/text, as `ops.js` `checkOrigin` already does; bump on viewport change by comparing metadata.
- **Blocker on the A/B claim** — "do not assume either works": source settles it. With `setInterceptDrags` off, a CDP `mousePressed` sets `initial_state_` and `InputHandler::StartDragging` runs the drag in DevTools' `DragController` (`input_handler.cc:1576–1590, 930–1000`): no OS drag loop, headed or headless. Variant A is the designed path. Fix: A first; B only as fallback if A fails. File items in B need `allow_file_access` (`:1443`).
- **Major — pressed-state cleanup.** `ClearInputState()` on detach/`Disable` only resolves pending callbacks (`:690–698, 2304`); it sends no mouse-up/key-up and does not end an ongoing drag. After an unexpected detach nothing can release. Fix: on revoke, best-effort `cancelDragging` (exists, `:1671`) + releases, then **close the dedicated tab** → `INPUT_STATE_UNKNOWN` becomes trivially recoverable.
- **Major — lease/link-loss timing.** 30 s lease / 10 s renew vs link loss seen only via ICE consent (~6 s, W3). Fix: W6's 3 s lease / 1 s renew, plus a dead-man ≤1 s while any button/key is held.
- **Major — dispatch deadlines.** `dispatchMouseEvent` waits for the renderer ack; mouse moves are rAF-aligned. A JS `alert()` or hung renderer blocks the serial queue. Fix: deadline per dispatch (as `ops.js` `send`); timeout → `INPUT_UNKNOWN` + revoke.
- **Major — ordering.** `offscreen.js` `onmessage` handlers are async and interleave across awaits. Fix: forward input synchronously in arrival order and enforce `seq` in the SW; a gap fails closed (never buffer).
- **Major — keys.** The `{code,key,modifiers}` envelope is not enough: Backspace/Enter need `windowsVirtualKeyCode`, Enter needs `text:"\r"`. Fix: closed worker-side key table; refuse other codes. Never send `nativeKeyCode` (without it events get `skip_if_unhandled` and cannot reach the worker browser's accelerators, `:1272–1275`). Text via `insertText` from the master's `beforeinput` (sidesteps PT dead keys); defer IME composition.
- **Minor — fps.** W6 gate caps LIVE ≤5 fps; that alone costs ~100–200 ms of p95. Fix: INTERACT mode ≤20–30 fps within the 1 MiB/s byte cap. Base64 over `chrome.runtime` at 30 fps is unmeasured.
- **Minor — SCTP.** ≤16 KiB visual messages sharing the association with input is probably fine `[unsure]` (stream scheduler); measure with the existing `visual.burst` knob.
- **OK** — single master monotonic clock and paint confirmation by pixel sampling on the master.

#### 3. Security

- **Major.** W1 is one-way (the master verifies the worker's proof); the worker only trusts per-message signatures. The plan binds the lease to `linkId`, but that is a worker-random UUID the master never sees (`offscreen.js` `serve`), and the per-message `workerId` is the same extension id on every root (W6.15). Fix: master signs `INTERACT_START` over **both DTLS fingerprints + bootId** (offscreen already knows both; each `RTCPeerConnection` gets fresh certificates). Also defeats a relay/MITM that forwards a genuine start and then injects unsigned events.
- **Major.** W6 never checks that `OBSERVE_STATUS/STOP` arrive on the session's link (`handle` uses `linkId` only in `begin`). For input: check `message.linkId === lease.linkId` on every event and renew.
- **Major.** N6 revokes after commit: a click on an off-allowlist link has already sent the request (same gap as W4 finding 5). Popups (`_blank`, `window.open`, middle-click) escape control and capture. Fix: record the leak as residual or add a `Fetch` guard on Document requests; close tabs whose `openerTabId` is the interact tab.
- **Minor.** W4's `hostile.js` (any code the origin serves) can still drive interaction; the plan says so correctly. The headed debugger infobar's "Cancel" is a real worker-side stop; say so in N15.
- **N cells.** Test a boundary: N1–N7, N9, N14 (unit node). Restate or only record capability: N8 (W6.11), N10 (W6.12 + bootId; only "SW restart closes the tab" is new), N11, N12 (separate roots, W6.07), N13 (functional), N15 (doc).

#### 4. Scope (minimal slices, each red→green)

1. Lock+auth: closed `input.v1`, signed start bound to the fingerprints, 3 s lease, link/seq checks; N1–N4, N9, N14 in node tests + 1 concurrent-start spec.
2. Interact tab + INTERACT capture with metadata + mapping; I1 headed+headless with 4-corner calibration; N7.
3. Keys/text/wheel: I2, I3; N5 (master closes mid-press → release/close tab).
4. Drag: I4 slider, I5 HTML5 variant A only.
5. 100 click samples/variant at paint (cheap), input RTT under `visual.burst`, secret-marker scan, one full lab, RESULTS + Codex review.

Cut/defer: F0 baseline run (W6 full lab already green), N8, N10 beyond restart-closes-tab, N11, N12, N13, N15 (doc), OOPIF, IME, overlay fixture, per-op-type p99, CPU/mem, F6 (→ MANUAL_VALIDATION).

#### 5. Missing risks/gates

- File chooser / `<select>` on a headed worker; `Page.setInterceptFileChooserDialog` through `chrome.debugger` `[unsure]` (not in `page_handler.cc`).
- SW restart while attached may leave an orphan debuggee + tab `[unsure]`: mark the tab in `storage.session` and close it at startup.
- The interact tab's initial URL is unspecified: add `url` to `INTERACT_START`, checked against the provisioned allowlist.
- `interactEnabled` must live in the provision record (only `lab.provision` writes it).

What I did: read the plan, RESULTS, W6-PLAN, PW-W6, worker/site code, and Chromium 157 `input_handler.cc`/`page_handler.cc`/`debugger_api.cc`. No tests or browsers.
