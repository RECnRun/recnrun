# Codex review of W6 (d51a4b81..9f3bcb96)

Model gpt-6.1-sol, effort high, read-only, 2026-11-07. Verdict: **not ready for GO** (G3 safety failures). The review is verbatim below; dispositions follow it. The fixes were not re-reviewed by Codex; the owner chose speed, so a second review goes to Phase 1.

## Dispositions

| #   | Severity | Disposition                                                                                                                                      |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Blocker  | Fixed in 579b50cb: a screenshot carries the capture generation from dispatch and is dropped after navigation, stop, unbind, or a new session.    |
| 2   | Major    | Fixed in 579b50cb: session, target, document, and deadline are checked again at every handoff and at send; navigation clears the pending frame.  |
| 3   | Major    | Fixed in 579b50cb: observe requests are validated and applied one at a time, and the live context is read again after each await.                |
| 4   | Major    | Fixed in 0ad03b8c: the master admits frames only for an accepted, unexpired session and its target; refusal, end, and disconnect revoke it.      |
| 5   | Major    | Fixed in 579b50cb (worker) and 0ad03b8c (master): a mode change drops or checks the pending frame against the new caps.                          |
| 6   | Major    | Fixed in 579b50cb and 0ad03b8c: reply listeners time out and close with the channel, rate history is bounded, retired cards revoke object URLs.  |
| 7   | Major    | Fixed in e2f67f14: scans read stored values for frame bytes, with a planted-JPEG control; the harness JPEGs are fixture evidence, named as such. |
| 8   | Major    | Fixed in e2f67f14: latency is measured at paint, and `w-scale` and `w-netem` assert first frame, paint p95, gaps, fps, and job delta.            |
| 9   | Major    | Fixed in 579b50cb: no clip or scale on `captureScreenshot`, so the emulation path is not taken; the worker downscales the image itself.          |
| 10  | Minor    | Fixed in 0ad03b8c: STALE follows the age of the last image, not telemetry.                                                                       |
| —   | Labels   | Accepted: the RESULTS W6 matrix uses LAB-ONLY and NOT TESTED as Codex lists them.                                                                |

## Review (verbatim)

**W6 is not ready for GO: G3 has reproducible safety failures.** Worker-owned capture, default OFF, separate `visual.v1`, and ordinary unproven-link rejection are implemented. No observation-driven ledger writes or explicit frame waits were added to job execution.

Paths below are under `tests/lab/web-master/`; line numbers refer to **9f3bcb96**.

1. **Blocker — screenshots can cross document boundaries.** `worker-extension/capture.js:131–142` awaits a screenshot, then `keep()` stamps it with the **current** URL, epoch, job, and tab (`:82–88`). My delayed-response probe returned old-document pixels labelled as the new document. Unlike screencast frames, screenshots have no generation check. This undermines origin and document confinement. **Fix:** snapshot the capture generation before dispatch and discard results after navigation, stop, unbind, or session replacement.

2. **Major — expiry is enforced by polling, not when sending.** `worker-extension/observe.js:43–48,100–105` checks deadlines every 250 ms; neither the sink nor `observe-gate.js:34–48` checks authorization at transmission. A delayed tick allowed my probe to send after `authorizedUntil`. Allowed navigation also leaves an old-document frame pending in the gate. **Fix:** revalidate session, target, document generation, and deadlines at every asynchronous handoff and final send; invalidate pending frames on navigation.

3. **Major — concurrent requests can roll authorization backward.** `worker-extension/observe.js:156–166` captures context before asynchronous validation and applies requests without serialization. With verification completion controlled, epoch 2 was accepted, then epoch 1 replaced it; `highestEpoch` became 1. Serial tests miss this. **Fix:** serialize validation and application, and recheck live context and expiry after awaits.

4. **Major — master admission precedes authorization and omits target/session checks.** `site/observe-client.js:100–104` admits frames before START succeeds. `site/visual-view.js:61–68` checks proof, worker, boot, and job, but ignores target, authorization expiry, and observation epoch. Worker ENDED telemetry does not call `endSession()`. My probe admitted an ancient-epoch, wrong-target envelope during this window. **Fix:** bind envelopes to the accepted observation session and target; revoke admission on expiry, refusal, end, and disconnect.

5. **Major — mode changes bypass dimension caps.** `worker-extension/observe-gate.js:51–67` validates dimensions only on offer. A pending 960×540 LIVE frame still flushes after switching to THUMBNAIL; reproduced in memory. **Fix:** discard or revalidate pending frames when changing mode.

6. **Major — memory bounds are incomplete.** `site/observe-client.js:9–18,77–85,107` creates reply listeners without timeout or close cleanup. Renewals continue accumulating listeners when replies disappear, including after channel closure. `worker-extension/observe-check.js:28–32` also stores every rate-limited arrival. Peer/channel maps lack retirement, and `site/dashboard.js:117` removes old cards without revoking their object URLs. **Fix:** bound outstanding requests and histories; cancel renewals and release connection/image resources on retirement. The frame slots, 256 KiB sender buffer, and per-receiver partial-frame limits themselves are real.

7. **Major — “zero frames stored anywhere” is false for this lab.** `visual-harness.ts:173–178` writes JPEGs; `w-visual.spec.ts:83,90` invokes it on successful runs. `site/scan.js:27` inspects IndexedDB store names, not values; the worker scan likewise does not inspect database contents. Those scans cannot prove the broad claim. **Fix:** explicitly authorize and label fixture-only artifacts, and test persistence using sentinel bytes across storage contents.

8. **Major — benchmark assertions prove weaker properties.** `site/visual-view.js:35–50` records arrival before image decoding or painting; `scale-harness.ts:77` calls this “capture-to-display.” `w-scale.spec.ts:195–201` checks finite latency, without enforcing latency, FPS, cost, or duration targets. `w-netem.spec.ts:185–188` can pass after streaming stops, provided buffers stay small and pings recover. **Fix:** measure decoded/presented frames and assert sustained delivery alongside control responsiveness and job outcomes.

9. **Major — job noninterference remains unproved [unsure].** `worker-extension/capture.js:131–142,211` takes scaled, clipped screenshots on startup and mode changes. Chromium’s `PageHandler::CaptureScreenshot` temporarily changes device emulation/view size, restored by `ScreenshotCaptured`; effects on viewport-sensitive applications or concurrent input were not exercised. **Fix:** avoid that mutation path or test those races explicitly. [Chromium source](https://raw.githubusercontent.com/chromium/chromium/157.0.8103.38/content/browser/devtools/protocol/page_handler.cc)

10. **Minor — STALE measures telemetry silence, not image freshness.** `site/card.js:37–38,62` lets heartbeats keep an arbitrarily old image fresh. The killed-worker test does not prove the static-image STALE requirement. **Fix:** track frame freshness separately from worker liveness.

W6.01–04 and the demonstrated dashboard/lifecycle cases merit **LAB-ONLY**. W6.15 proves rejection on an unchecked link, but durable authenticity remains **LAB-ONLY** because the harness supplies the worker key. W6.16 is Linux-only. W6.17 PWA, W6.18 real signalling, macOS, resize, ten-worker stress, actual display latency, and native prompt absence remain **NOT TESTED**; prompt screenshots are recorded, not asserted. W6.06/13 safety and blanket W6.14 privacy should not be PASS. `RESULTS.md` still lacks the acceptance matrix.

Exercised: committed-source review, browser-free VM probes reproducing findings 1–5, and `git diff --check` (passed). No files edited or browsers launched; browser tests and `verify` were not rerun under the requested scope.
