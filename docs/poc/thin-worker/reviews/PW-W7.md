# Codex review of W7 (edcb5681..f99e0678)

Model gpt-6.1-sol, effort high, read-only, 2026-11-07. Verdict: **NO-GO pending fixes** (five blockers). The review is verbatim below; dispositions follow it. The fixes were not re-reviewed by Codex; a second review goes to Phase 1, as for W6.

## Dispositions

| #   | Severity | Disposition                                                                                                                                                                                                                               |
| --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | blocker  | Fixed in fee645d4: revoke ends the lease ahead of the queue; queue bounded (64 deep, 1 s old, 200/s); deadlines on every awaited call                                                                                                     |
| 2   | blocker  | Fixed in fee645d4: lease rechecked after the document read, no await before `Input.*`                                                                                                                                                     |
| 3   | blocker  | Fixed in 22ef4caa: a frame becomes aimable only after the master decoded and painted it                                                                                                                                                   |
| 4   | blocker  | Fixed in 22ef4caa: the worker reads the current viewport (isolated world) before each dispatch                                                                                                                                            |
| 5   | blocker  | Fixed in fee645d4: unconfirmed release revokes with `INPUT_STATE_UNKNOWN` and closes the tab                                                                                                                                              |
| 6   | major    | Fixed in fee645d4: tab, marker, and claim kept until close is confirmed; failed startup recovery blocks the claim                                                                                                                         |
| 7   | major    | Fixed in fee645d4: `cancelDragging` first; stop mid-HTML5-drag gives 0 drops                                                                                                                                                              |
| 8   | major    | Fixed in fee645d4: `hold` gets the full checks; only accepted events re-arm the dead man                                                                                                                                                  |
| 9   | major    | Fixed in fee645d4: a `canceled_by_user` detach latches the worker stop; unit-tested only; workers start with `--silent-debugger-extension-api` (PLAN decision 8), so the infobar shows only on a worker started without it (P5.1, M-TW.3) |
| 10  | major    | Fixed in 2dd4f8fc: an 8-cell binary press counter decoded from the presented frame, timed at presentation                                                                                                                                 |
| 11  | minor    | Fixed in 14a66d4e: scans also cover sessionStorage, the offscreen document's storage, and OPFS on both sides                                                                                                                              |

Labels accepted: I1–I5 and the ordinary N cells are LAB-ONLY; N10 service-worker restart and N11, N13 are NOT TESTED; N12 has one load check. The infobar Cancel applies only to a worker started without `--silent-debugger-extension-api`.

## Review (verbatim)

**Verdict: NO-GO pending fixes.** Reviewed `edcb5681..f99e0678`, using committed files at `f99e0678`. Paths below are under `tests/lab/web-master/`.

1. **Blocker — revocation cannot jump the queue.** `worker-extension/interact.js:78,176,183,199,209` queues link loss, navigation, expiry, and worker stop behind input. There is no queue depth, age, or event-rate bound; `openTab()` and `refresh()` include unbounded awaits. Dead-man releases also queue (`interact-events.js:35`). Buffered renewals/holds can prolong activity after master loss. **Fix:** invalidate authorization immediately outside the queue, discard pending work, and bound receipt age, depth, rate, and every awaited operation.

2. **Blocker — input can dispatch after lease expiry.** `worker-extension/interact.js:138` admits the lease before `interact-events.js:46–53` awaits document/zoom reads and dispatches. Expiry during those awaits does not prevent the effect; its timer waits behind that event. **Fix:** recheck lease identity, expiry, and cancellation immediately before every effect.

3. **Blocker — events can name a document the owner has not seen.** `site/interact-view.js:131` trusts `shownFrame()`, but `site/visual-view.js:57` advances that identity before image decoding/presentation succeeds. During replacement, old pixels can remain visible while input names the new document. **Fix:** publish the input frame identity only after that exact image is presented; suspend input during replacement.

4. **Blocker — viewport validation has a blind window.** `worker-extension/interact-frames.js:65` compares geometry against the latest **sent** frame, not the current viewport. Resize/pinch changes before another frame is sent therefore pass. `w-interact-click.spec.ts:190` explicitly waits for changed geometry, hiding this window. **Fix:** validate current layout/viewport generation before dispatch and test input before the replacement frame.

5. **Blocker — failed dead-man releases lose the held state.** `worker-extension/interact-tab.js:136–146` clears tracking before attempting releases; failures only increment counters. The dead-man caller neither revokes nor closes the tab. Renewals can continue with an actually held input now recorded as released. **Fix:** treat failed or uncertain release as `INPUT_STATE_UNKNOWN` and close the target.

6. **Major — failed tab closure permits overlapping ownership.** `worker-extension/interact-tab.js:101–108` forgets the target, swallows removal failure, and deletes its recovery marker; `interact.js:59` then releases admission. Startup recovery similarly forgets unsuccessful removal (`interact-tab.js:34–35`). A surviving interactive tab can coexist with a new job. **Fix:** retain the target, marker, and claim until closure is confirmed; latch failure.

7. **Major — cleanup can complete a drag instead of cancelling it.** `worker-extension/interact-tab.js:139–140` sends releases before `cancelDragging`. Chromium’s `InputHandler::DragController::HandleMouseEvent` routes mouse-up into `EndDraggingWithRenderWidgetHostAtPoint`, which calls `DragTargetDrop`. **Fix:** cancel dragging before mouse release; assert zero drops during revocation. [Chromium implementation](https://raw.githubusercontent.com/chromium/chromium/157.0.8103.38/content/browser/devtools/protocol/input_handler.cc)

8. **Major — `hold` bypasses document/frame checks.** `worker-extension/interact-events.js:40–42` returns before policy, loader, viewport, or freshness validation, then rearms the dead man. Even refused ordinary events rearm it through `finally`. Thus stale or invalid traffic can sustain an existing press. **Fix:** rearm only from accepted, current-document activity, including a suitably bound hold.

9. **Major — the real headed stop is not latched.** `worker-extension/interact-tab.js:46–47` handles debugger detach by ordinary revocation; only `interactLab.stop()` persists `interactStop`. Consequently the infobar Cancel does not prevent another start. `w-interact-auth.spec.ts:204` tests the CDP lab hook instead. **Fix:** latch user cancellation and test attempted restart through that path.

10. **Major — “visible latency” does not measure the displayed frame.** `site/interact-latency.js:31–47` decodes an incoming Blob independently, then timestamps an unrelated animation frame. It never confirms that Blob became the displayed image. Four repeating colours also fail the plan’s unique-action-marker requirement; 150 ms spacing is not causal proof. **Fix:** decode a unique action ID and correlate it with presentation of the exact frame.

11. **Minor — privacy evidence is narrower than the claim.** `site/scan.js:54` omits sessionStorage/OPFS; neither side’s scan proves absence from logs or artifacts. **Fix:** expand controlled scans or explicitly limit the assertion to inspected stores.

The 128-frame record, 4 KiB text limit, and ±1,000 dispatched wheel clamp are real. Ordinary cross-link rejection and shared job admission look correct. Current click tests assert a real headless worker; I found no page-level worker CDP input in W7.

Label demonstrated I1–I5 and ordinary N1–N4/N6–N9/N14 checks **LAB-ONLY**. Mark race/failure guarantees above **NOT TESTED**, including bounded cleanup, dispatch timeout recovery, and cancellation without drop. N10 service-worker restart, N11–N13, actual infobar N15, and exact-frame presentation latency remain **NOT TESTED**. Gate W7 is explicitly unrun.

Exercised: committed-source/diff review and Chromium source inspection only. No edits, browsers, tests, or Docker; runtime reproduction was excluded by request.
