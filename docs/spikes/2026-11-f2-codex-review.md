# Codex review of F2 (2026-11-03)

Review of `git diff 954b7c3...5cd18ee` (branch `f2-vertical` against `f1-spike`) by Codex with `gpt-6.1-sol` at high reasoning, read-only, as step 5 of the [checklist protocol](../plan/CHECKLIST.md#resume-protocol). The orchestrator's decisions are in the checklist's F2 `review:` line.

**Request changes.** The F2 slice has substantial coverage and sound boundary-validation foundations, but several defects undermine its control, persistence, and shutdown guarantees. I reproduced failures involving stale fences, lock recovery, secret inputs, replay deadlines, normalization, and capture pauses using in-memory checks against the reviewed code. The existing integration tests largely exercise successful, sequential paths and miss these cases.

## Critical

None identified.

## High

1. **`packages/persistence/src/service-state-store.ts:102` — Stale-lock removal can delete a replacement owner’s lock.**  
   `removeLock()` reads and checks the nonce, then separately unlinks the pathname. Two starters can both read the stale nonce; one removes it and acquires a new lock, then the other unlinks that new lock using its earlier observation. Both can subsequently start services against the same storage. An in-memory interleaving reproduced deletion of the replacement lock. **Fix:** serialize recovery across processes, or use an operating-system lock held throughout the service lifetime. Another nonce read alone does not eliminate the race.

2. **`apps/service/src/commands.ts:59` — Controlled mutations bypass fencing, including after lease expiry.**  
   Pause, resume, stop, picker-stop, and draft mutations ignore the envelope’s fence. Separately, `control.ts:14` accepts any supplied fence when no live lease remains. I reproduced token 1 pausing and stopping a session controlled under token 3, and an expired fence successfully starting the picker. A delayed former holder can therefore disrupt the current holder. **Fix:** enforce authorization consistently before controlled mutations; reject supplied stale or expired fences. Preserve the explicit manual-takeover exception.

3. **`apps/service/src/service.ts:121` — Shutdown can report success while replay journals remain open.**  
   After five seconds, shutdown closes the flow store and drains the session journal registry regardless of whether replay finished. Replay journals bypass that registry: `runs.ts:77` opens them directly. The signal handler then calls `process.exit(0)`, potentially terminating pending writes. Replay also lacks exceptional cleanup: an injected journal-append failure escaped `replayFlow()` with **zero journal-close calls**, because closing occurs only in `recorder.finish()`. **Fix:** give replay journals explicit lifecycle ownership, close them in `finally`, and cancel or settle active execution before draining and closing storage. Add a SIGTERM test during an actual replay.

4. **`apps/service/src/runs.ts:56` — Secrets entered in the UI never reach the executor’s secret scope.**  
   The UI submits password fields through `inputs`, but service execution forwards only `inputs`; the strict `replay schema` provides no `secrets` field. Meanwhile, `scope.ts:36` deliberately resolves secret inputs exclusively from `options.secrets`. A valid replay request containing a required secret reproduced `{ missing: "pin" }`. Recorded `${secrets.password}` references likewise have no service resolution path. **Fix:** provide a validated, transient secret channel and forward it separately to the executor; make recorded secret references available through the run form without persisting their values.

5. **`packages/engine/src/replay/wait.ts:57` — Step deadlines do not bound awaited operations.**  
   `pollUntil()` awaits a read without a deadline guard and accepts success before checking elapsed time. Some adapter operations have no timeout at all: `replay-tabs.ts:23` awaits page titles, while tab creation, selection, and closure also escape the supplied budget. A URL assertion with `timeoutMs: 10` reproduced **passed after 152 ms** through the real page-driver composition and a slow title read. A stalled operation can hang indefinitely. **Fix:** propagate the deadline through every operation and reject late read results. Bound dispatched writes with cancellation and an indeterminate outcome, without retrying them.

6. **`packages/engine/src/normalization/fields.ts:78` — Per-key normalization loses deletion operations.**  
   Backspace edits `token.text`; it is not retained as a key operation. When a special key divides the field run, the deletion may affect text represented by an earlier token, leaving an empty current token that `typeDraft()` drops. Schema-valid events for typing `ab`, pressing ArrowLeft, then Backspace produced only `type "ab"` and `keyPress ArrowLeft`: the recording ends at `b`, while replay retains `ab`. **Fix:** preserve deletion and cursor-sensitive operations explicitly whenever choosing per-key replay, and add this sequence as a regression.

## Medium

7. **`packages/persistence/src/flow-store.ts:69` — Flow reads can combine different saved versions.**  
   `getFlow()` independently reads the manifest and YAML, then returns the YAML’s hash without checking it against the manifest. `saveFlow()` replaces YAML before committing the manifest, and reads do not join the write queue. A concurrent read—or a crash between those writes—can expose new content alongside old history and catalog metadata. Replay uses that unchecked YAML hash. **Fix:** read committed content through `manifest.revision`, validate identity and consistency, and define recovery for an interrupted YAML/manifest update.

8. **`apps/service/src/control.ts:63` — Picker startup races with cancellation and session stop.**  
   `live.picker` remains unset while `browser.pick()` is pending. Stop therefore sees nothing to close; startup later installs the handle into the already stopped session. Concurrent starts can also create two handles and overwrite one. I reproduced `picker.start` returning `picking: true` after session stop, with zero picker-close calls. **Fix:** track the pending startup, serialize lifecycle operations, and recheck session state and fence before retaining the handle. Close handles whose startup was superseded.

9. **`apps/service/src/sessions.ts:117` — Pausing step creation still creates navigation steps.**  
   Only DOM events are marked ignored while `pauseStepCreation` is active. Navigation events remain eligible for normalization. I reproduced a `navigate` suggestion from a navigation occurring entirely during the pause. This contradicts the documented pause semantics and can insert setup or exploratory navigation into the saved flow. **Fix:** exclude every event that can contribute to suggested steps during this pause, while retaining the complete journal.

10. **`apps/service/src/sessions.ts:214` — Stop discards capture results it waits to drain.**  
    The session becomes `finalizing` before `recording.settled()` and `recording.stop()`. Consequently, `accept()` rejects events delivered during settling, including outstanding response-body reads and capture-stop results. An injected event emitted during `settled()` was silently absent from the journal. **Fix:** distinguish stopping new capture from draining already accepted capture work; journal pending results before closing the session, and represent any discarded evidence as a gap.

11. **`packages/adapter/src/picker-source.ts:42` — The shield cannot prevent application capture handlers from running.**  
    The picker swallows events on the shield element, after window and document capture listeners have already received them. A document-level click-outside handler can close a menu or otherwise mutate the application during selection. The existing browser test proves only that the underlying button’s handler does not run. **Fix:** intercept selection input before application dispatch, such as through browser-level inspection, and test window/document capture handlers as well as target handlers.

12. **`apps/cli/src/run.ts:47` — `--flow <dir> --dataset <name>` never loads that folder’s dataset.**  
    The CLI imports only `flow.yaml`, then sends the dataset name. The service resolves the dataset exclusively from its own flow-store folder at `runs.ts:77`. On a fresh home, a valid external flow folder containing `datasets/default.json` therefore fails with `not-found`. The `CLI contract tests` replace replay with canned handlers, hiding this integration failure. **Fix:** validate and import the selected dataset, or load it locally and pass its non-secret inputs. Exercise the real dataset path through the CLI.

13. **`apps/ui/src/features/run/useRun.ts:39` — A missed terminal push leaves the Run screen permanently running.**  
    Completion depends entirely on receiving `run.finished`. WebSocket reconnect only resubscribes; it does not recover missed state. Additionally, `execute()` records infrastructure failures without publishing a terminal message. A disconnected socket during completion, or a failed Chrome connection, leaves Start disabled indefinitely despite `run.summary` already being answerable. **Fix:** reconcile through `run.summary` after startup and reconnect, with polling or another recovery mechanism, and surface terminal infrastructure errors.

14. **`apps/cli/src/run.ts:48` — CLI-owned services have no signal cleanup during `run`.**  
    `connect()` can start the service inside the CLI process, but signal handling is installed only by `the `open` command`. SIGTERM or Ctrl-C during a standalone run therefore terminates the process without executing `connection.close()`; ordinary `finally` blocks do not run on default signal termination. **Fix:** install temporary signal cleanup whenever the CLI owns a service, remove it after normal cleanup, and return an appropriate interrupted/error exit code.

15. **`apps/ui/src/features/recorder/Recorder.tsx:63` — Navigation loses access to an active recording.**  
    The session identifier exists only in Recorder component state. Switching to Setup or Flows unmounts that component through `App.tsx:34`, while service capture continues. Returning to Record presents a new-session form, leaving the previous recording active without visible stop/save controls. **Fix:** retain active-session identity above screen routing and restore its controls when returning; provide recovery after a page reload.

## Low

None reported.

Verification was limited to source inspection and read-only, in-memory execution; live HTTP, Chrome, Docker suites, and `vp run verify` could not run because the sandbox prohibits writes and loopback binding returned `EPERM`. No files changed.

Verified and found correct:

- All **28 generated JSON Schema documents match** the committed files.
- Executed Host/Origin rejection, token matching, strict parameter validation, and invalid-result rejection checks: passed.
- Executed unknown-write-outcome check: exactly one dispatch, an `indeterminate` step, and the following step blocked.
- Static serving uses a restricted asset-path allowlist, `no-store`, CSP, and anti-framing headers; UI source contains no `innerHTML` or `dangerouslySetInnerHTML` rendering.
