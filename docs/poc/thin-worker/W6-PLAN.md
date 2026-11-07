# POC W6: visual observability of the workers over WebRTC

Owner plan of 2026-11-07, condensed into English. Base: `poc-thin-worker` after Gate W. Branch: `poc-w6-visual-observability`. Results go to [RESULTS.md](RESULTS.md#w6), the review to `reviews/PW-W6.md`.

## Question

Can recnrun.com, as a tab or an installed PWA in the Default profile, watch several workers (isolated Chrome roots, headed and headless) run their jobs, over the existing WebRTC P2P link, without changing or gating how the jobs run? Read-only: no remote click, keyboard, focus, or new automation. W6's verdict is separate from the decision to replace the extension master with the site.

Not W6 evidence: W1 (P2P with mDNS, harness-relayed SDP), W2 (folder grant persists), W3 (jobs finish without the master), W4 (trust limits and the residual compromised-master risk). The lab still uses `--remote-debugging-port` and `--enable-unsafe-extension-debugging`.

## Constraints

- Master is the site or PWA; the worker is the existing lab worker extension. No companion, daemon, server, Store extension, or Playwright in the execution path. Harness helpers are lab-only and named as such.
- No change to the target application, no SDK injected into it.
- No media server, required TURN, frame upload, or recording. No TURN limits the network cases; say so.
- Streaming never advances, confirms, or writes the ledger.
- Frames get their own authorization, rate, and byte budget; W4's 64 KiB read budget does not cover images.
- Visual traffic is off by default until the master asks, per worker and target, with an expiry and a visible indicator.

Out of scope: audio, desktop capture, other apps, remote control, recording or replay of video, third-party viewers, internet reach, several viewers at once, a no-flags product path before it is proven, hundreds of workers.

## Runtime found before coding (Gate G0 inventory)

| Fact                                    | Where                                                                                                                   | Runs in               |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Worker is an MV3 extension              | `tests/lab/web-master/worker-extension/manifest.json` (`debugger` permission)                                           | worker                |
| Worker owns the job tab's CDP           | `runner.js` `run()`: `chrome.debugger.attach({tabId}, "1.3")`, tab `active:false`, `Emulation.setFocusEmulationEnabled` | worker service worker |
| WebRTC answers in an offscreen document | `offscreen.js` (`answer`, `serve`), one channel `recnrun-lab` the master creates in `site/master.js`                    | worker offscreen      |
| Identity and job proof                  | `offscreen.js` `sign`, `job-check.js`, `job-schema.js`                                                                  | worker                |
| Ledger                                  | `ledger.js`, `runner.js` `save`/`publish`                                                                               | worker                |
| Install (pipe, Developer mode, reload)  | `lifecycle-harness.ts` `provisionWorker`                                                                                | harness only          |
| SDP relay, `lab.*` evaluation           | `lifecycle-harness.ts` `link`, `startWorker` (attaches to the service worker only)                                      | harness only          |
| Debug flags                             | `startWorker`: `--enable-unsafe-extension-debugging --remote-debugging-port=0`                                          | harness only          |

The worker's own `chrome.debugger` is an extension API: it needs neither flag. The flags serve install and the harness's eval and relay. W6.01 and W6.16 must show that capture keeps working with no page-level client and with both flags off.

## Gates

- G0 Access: the worker itself drives the pixel source (`Page.startScreencast` / `Page.captureScreenshot` over its `chrome.debugger`), with no external client.
- G1 Capture: real frames headed and headless, background tab included, with the no-frame cases named.
- G2 Transport: binary frames over a separate `visual.v1` channel on the existing peer connection, bounded buffer, control stays responsive.
- G3 Safety: authorization, identity, expiry, target policy, no persistence, no W4 regression.
- G4 UX and lifecycle: dashboard tells live, stale, paused, and offline apart for 3 workers; W3 jobs finish without the master.
- G5 Production feasibility: no special flags on real macOS, and real signalling (not the harness relay), proven or explicitly blocked.

GO needs G0–G5. GO-LAB-ONLY: visual works and W1–W4 hold, but it depends on flags, the harness relay, missing mutual identity, or missing macOS. NO-GO: the worker cannot capture by itself, streaming breaks jobs, trust lets capture through, network loss duplicates execution, or cost is uncontrollable.

## Slices

1. **A, capture (G0, G1).** Deterministic visual fixture (counter, text change, animation, modal, navigation) on the target server. Worker `capture.js`: start, frame, ack, stop, snapshot, visibility, detach, over the runner's own debuggee. Prove headed, headless, background tab, navigation, resize, static page (heartbeat `NO_CHANGE`, `captureScreenshot` fallback), closed target, detach. Lab readout only through files or `lab.*`, never a page-level client.
2. **B, transport (G2).** Master opens `visual.v1` (`ordered:false, maxRetransmits:0`) on the existing peer connection. Closed binary envelope, 16 KiB chunks clamped to the negotiated `maxMessageSize`, one frame in flight, latest wins, `bufferedAmount` cap 256 KiB. Receiver: complete frames only, 512 KiB per frame, chunk limits, 2 s TTL, epoch and sequence checks. No frame persisted anywhere; the UI keeps the last one.
3. **C, control and trust (G3).** Closed messages `OBSERVE_START`, `OBSERVE_STOP`, `OBSERVE_SET_MODE`, `OBSERVE_STATUS`, `VISUAL_HEARTBEAT`, `VISUAL_ERROR`, signed by the pinned master key with nonce, epoch, and expiry. Worker-local caps the site cannot raise: THUMBNAIL ≤ 1 fps, LIVE ≤ 5 fps, ≤ 1 MiB/s, bounded duration, target must be the job's tab on an allowed origin, refuse `chrome://`, extension pages, and off-policy redirects. Frames bound to the worker's signed proof on the link. Master gone (heartbeat, not `beforeunload`) stops capture; a worker restart invalidates `bootId` and sessions.
4. **D, dashboard (G4).** Grid of cards (short worker id, job, status from the ledger and telemetry, last frame with age and STALE), viewer with LIVE, timing, fps, drops, stop button, action overlay only when coordinates align. Default OFF; enabling gives thumbnails; the open viewer alone asks LIVE. Same in tab and PWA. A notice that images may hold authenticated content and nothing leaves the machine.
5. **E, benchmarks and failures.** 1, 3 (and 10 as stress) workers, headed and headless, master tab visible and hidden, PWA. Loss, jitter, delay, outage, saturated channel, master closed, worker restart, detach, refused origin. Count gestures and prompts after onboarding. A no-flags run of the worker root. Metrics to `metrics.json` per scenario.

Each slice: failing test first, then the change, then the same command passing. Real Chrome for any pixel claim; mocks only for codec and protocol.

## Acceptance

W6.01–W6.20 as in the owner's plan: provenance, headed, headless, background, first image, navigation, multi-worker, viewer modes, master closes, master reopens, slow network, CDP detach, trust refusals, sensitive content, worker authenticity, no flags, PWA and tab, real signalling, regression, reproducibility. Each gets PASS, FAIL, NOT TESTED, or LAB-ONLY with evidence.

## Metrics

Per worker, mode, and environment: frames captured, sent, received, displayed, dropped (by reason), expired; frame bytes; visual `bufferedAmount`; capture errors; capture-to-display and request-to-first-frame p50 and p95; effective fps; bytes per second; CPU and memory against a no-stream control; reconnect time; job duration and failure deltas. Provisional lab targets: first frame p95 ≤ 2 s, LIVE frame p95 ≤ 1.5 s, thumbnail ≤ 1 fps with STALE when static, viewer ≤ 5 fps at 960×540 JPEG q60, bounded queue, no job change, no prompt after onboarding, zero frames stored. A target met at the cost of job stability is NO-GO.
