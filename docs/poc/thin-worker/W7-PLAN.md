# W7 plan: remote interaction from the site master

The owner works from the master's viewer of one worker and clicks, types, scrolls, and drags in the worker's page over the WebRTC link. This plan revises the owner's draft (`RECnRun-POC-W7-Remote-Interaction.md`, kept outside the repository) after two reviews: [reviews/PW-W7-plan.md](reviews/PW-W7-plan.md) (Codex and Opus). The goal is a fast lab GO/NO-GO, not product code.

Base: branch `poc-w7-remote-input` from `poc-w6-visual-observability` at edcb5681 (W6 GO-LAB-ONLY).

## Rules

- Provisioning may use external CDP and lab flags as today. After it, every master↔worker byte goes over WebRTC, and the worker drives its own tab through `chrome.debugger`. No Playwright, page-level CDP client, companion, server, or Store in the input path.
- Throwaway code only under `tests/lab/web-master/` (worker: `worker-extension/input-*.js`, `interact*.js`; site: `site/input-*.js`; specs `w-interact*.spec.ts`; node tests `interact*.test.ts`). No `apps/*/src`, `packages/*/src`, or new packages.
- Speed first: one red and one green run of the targeted spec per behavior; no baseline full run (W6's full lab is the baseline); the full lab and `vp run verify` run once, at Gate W7.
- Browsers only in Docker (`vp run lab:web-master`, `node scripts/test-container.mjs lab:web-master:local <args>`). Never on the host.

## Design

**Target.** A dedicated interactive tab, owned by the worker, created `active:false` at `INTERACT_START.url` (checked against the provisioned allowlist), attached with `chrome.debugger`, focus emulation on. The tab is marked in `storage.session`, so a service worker that restarts closes it at startup. Tabs opened from it (`openerTabId`) are closed.

**Exclusion.** `INTERACT_START` enters the runner's existing admission queue and `running` claim, so a job and an interaction exclude each other (BUSY both ways). Interaction writes no ledger entry. Ownership is released only after cleanup or after the tab closes.

**Capture.** The W6 pipeline is reused with `capture.bind(target, interactId)`; site admission accepts `interactId` in place of `jobId`. A new worker-local INTERACT mode raises the frame cap to 20–30 fps within the 1 MiB/s byte cap. Each frame keeps the screencast metadata (`deviceWidth`, `deviceHeight`, `pageScaleFactor`, `offsetTop`). Screenshot-fallback frames carry none and cannot be input targets. The master may ask for a fresh frame.

**Link-bound authentication.** The worker answers `INTERACT_CHALLENGE` with a nonce, its `bootId`, and both DTLS fingerprints of this exact `RTCPeerConnection`. The master signs `INTERACT_START` over these values, `url`, and `exp`. The worker checks the pinned key and that the fingerprints and `bootId` match the link the start arrived on. The lease lasts 3 s with a 1 s renew. It is bound to that link and never migrates; a renew or input event from another link is refused. Input events are not signed: they carry `leaseId`, `seq`, and frame identity, and the worker checks them against the lease.

**`input.v1` channel.** Ordered and reliable, one channel per link (a duplicate is refused). The offscreen document forwards messages synchronously in arrival order. The service worker enforces `seq`: a gap fails closed, nothing is buffered. One serial dispatch queue has bounded depth and age; each dispatch has a deadline. On timeout the worker reports `INPUT_UNKNOWN` and revokes. Revocation jumps the queue.

**Frame identity and mapping.**

- Each event carries `bootId`, `sessionEpoch`, `frameSeq`, the document epoch, and normalized `x`, `y` over the image area. The document epoch is the main-frame `loaderId`.
- The worker refuses the event in these cases:
  - the frame is unknown or older than 1.5 s;
  - the `loaderId` changed (re-read through `Page.getFrameTree` before every down, key, or text event);
  - the metadata changed.
- Coordinates map as `xCss = xNorm · deviceWidth / (zoom · pageScaleFactor)`, and the same for `y` with `offsetTop`. Zoom comes from `Page.getLayoutMetrics` per epoch and on resize. No scroll offset is added.

**Events.**

- `pointerMove` (coalesced on the master), `pointerDown`, `pointerUp`, `wheel`.
- `key`: a worker-side closed table (Enter with `text:"\r"`, Backspace, Tab, arrows, Escape) with `windowsVirtualKeyCode`. No `nativeKeyCode` is ever sent.
- `text`: `insertText` from the master's `beforeinput`, at most 4 KiB.
- Unknown kinds or fields are refused. IME composition is deferred.

**Pressed state.**

- The worker tracks held buttons and keys.
- A dead-man timer of at most 1 s runs while anything is held.
- On revoke, lease expiry, link loss, master close, or a stop, the worker sends best-effort releases and `cancelDragging`, then closes the interactive tab. A closed tab is the recovery from `INPUT_STATE_UNKNOWN`.
- Typed text never reaches logs.

**Drag.** Variant A, plain mouse events, is the designed path: with drag interception off, `InputHandler::StartDragging` runs the drag inside DevTools' `DragController`. Variant B (`setInterceptDrags` + `dispatchDragEvent`) runs only if A fails or if it is cheap to compare. It needs a genuine source drag and explicit cancellation.

**Stated boundary.** The worker confines input to the top-level origin it checks before each effect. The following are residual risks, recorded and not claimed as confined:

- cross-origin iframes;
- form destinations;
- the request already sent by a click that navigates off the allowlist (revoked after commit; same gap as W4 finding 5);
- network side effects;
- a compromised site origin driving live input.

The headed debugger infobar's Cancel is a worker-side stop.

**Off by default.** `interactEnabled` lives in the provision record per worker and origin; only `lab.provision` writes it.

## Slices

Each slice: an Opus implementer, red then green on its targeted command, one commit, a CHECKLIST line. Node tests cover pure logic; one spec per behavior covers the browser.

| Slice | Content                                                                                                                                                                                                                                                                                                           | Cells                  |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| A     | Closed `input.v1` schema and checks, challenge and signed start bound to fingerprints and `bootId`, 3 s lease and renew, link and `seq` checks, shared admission with jobs, `interactEnabled` off by default, latched stop                                                                                        | N1–N4, N9, N14, N15    |
| B     | Interactive tab lifecycle, INTERACT capture mode with metadata, site admission by `interactId`, mapping, click with four-corner calibration, stale frame/epoch/resize refusals, off-allowlist navigation and opener tabs; headed and headless (`playwright.config.ts` headless regex extended)                    | I1, N6, N7             |
| C     | Key table, text (`Olá ação 123`, Backspace, Enter, one submit), wheel on page and inner container, pressed-state cleanup (master closes mid-press, link loss, service worker restart closes the tab), dispatch deadline                                                                                           | I2, I3, N5, N10        |
| D     | Slider and canvas drag with release on disconnect (I4); HTML5 reorder, variant A first (I5); click latency at paint on one master clock (at least 30 samples per mode, raw distribution, a unique action marker decoded in the frame); input round trip under `visual.burst`; secret-marker scan of stored values | I4, I5, N8 (one check) |

Deferred: N11 (shortcuts and native IME), N12 (three workers; W6.07 covers separate roots), N13 (overlays, cross-origin iframes), OOPIF, CPU/memory, per-op p99, file choosers and `<select>` popups (`[unsure]` through `chrome.debugger`).

## Gate W7

1. One full lab run.
2. `vp run verify`.
3. Codex review of the W7 diff, saved to `reviews/PW-W7.md`, with findings fixed.
4. The [RESULTS.md](RESULTS.md) W7 section: I1–I5 and N1–N15 as LAB-ONLY, NOT TESTED, or deferred, with the verdict.
5. Push and CI.

The verdict ceiling is **GO-LAB-ONLY**. These stay owner-manual: macOS without flags, the personal Default profile as master, real signalling, and the owner's risk acceptance for remote control. They are listed in [MANUAL_VALIDATION.md](MANUAL_VALIDATION.md).

NO-GO if any of these hold:

- input lands on a document other than the one shown;
- input arrives without a valid lease on the same link;
- a button or key stays held after revoke;
- interaction and a job run on the worker at the same time;
- I1 or I2 cannot pass headed and headless.
