# Codex review of F1 (2026-11-02)

Review of `git diff aeedb12...36cc8e1` (branch `f1-spike` against `f0-contracts`) by Codex with `gpt-6.1-sol` at high reasoning, read-only, as step 5 of the [checklist protocol](../plan/CHECKLIST.md#resume-protocol). The orchestrator's decisions are in the checklist's F1 `review:` line. Findings 1 to 15 were all reproduced with a failing test and fixed on `f1-spike`; finding 1 reproduced with an array iterator or a proxy over an array, not with the review's plain-object example.

**Request changes.** The diff has substantial F1 coverage, but it still contains reproducible journal corruption, missed locator deadlines, password disclosure, lost binding updates, and connection leaks. Some browser tests also overstate what production code proves, particularly actor routing and popup document identity. The checklist correctly leaves F1.8 and the final F1 verification gate outstanding.

## Critical

None found.

## High

1. **`packages/adapter/src/function-locator.ts:114` — Result conversion can execute JavaScript outside the deadline.**  
   Only the initial locator call is bounded at line 99. `TO_ELEMENTS` subsequently invokes `Array.from()` without a timeout. A locator returning an array whose iterator loops forever therefore wedges the renderer without triggering `terminateExecution`. A stalled conversion probe remained pending past its deadline. **Fix:** apply a shared deadline and termination handling to every evaluation that can execute locator-controlled code, including conversion.

2. **`packages/persistence/src/journal.ts:76` — A failed partial write corrupts subsequent successful appends.**  
   Catching the write rejection resets `tail` to success. If an append writes part of its JSON and then fails—for example, on disk exhaustion—the next append joins that fragment. I reproduced a rejected first append followed by a successful second append and `close()`, after which `readJournal()` rejected line 1 as invalid JSON. **Fix:** put the writer into a failed state after an I/O error; reject subsequent appends and surface the failure from `close()`.

3. **`packages/adapter/src/hook-dom.ts:58` — Composition events disclose password text.**  
   Keyboard and input handlers check `isSecret()`, but the composition handler unconditionally includes `event.data`. Dispatching composition events against a password field produced plaintext `"secret"` in all three composition messages. These messages pass the observer schema and can reach the journal. **Fix:** redact composition data for password fields and add negative tests covering every text-bearing event.

4. **`packages/adapter/src/connection.ts:143` — CDP connections do not enforce the loopback restriction.**  
   `connect()` forwards arbitrary endpoints to the transport; `packages/adapter/src/cdp-socket.ts:103` likewise constructs a socket without checking its destination. A probe confirmed that a non-loopback endpoint reaches the socket constructor. Discovery producing loopback URLs does not protect these public entrypoints. **Fix:** validate endpoints before any network operation across all CDP connection paths, and add negative tests proving remote destinations are rejected before socket creation.

## Medium

5. **`packages/adapter/src/capture-network.ts:197` — Response-body reads can leave `settled()` hanging.**  
   `read()` changes the state to `"reading"`, while the existing timer explicitly ignores that state at line 160. The tracked `getResponseBody` promise has no deadline. A never-answering command produced no body event after the timeout; even `NetworkCapture.close()` left its tracked work pending. The browser fixture awaits `settled()` before stopping, so teardown can hang too. **Fix:** bound the read itself and ensure timeout, detach, and stop settle tracked work independently of a late CDP reply.

6. **`packages/persistence/src/bindings-store.ts:86` — Concurrent mutations lose bindings.**  
   Each `save()` independently reads, modifies, and replaces the file. Atomic rename prevents partial files but does not serialize those transactions. In a controlled probe, concurrent saves of A and B both succeeded, yet only B remained. `remove()` has the same race. **Fix:** serialize the complete read-modify-write transaction per store path and define how multiple store instances share ownership.

7. **`packages/adapter/src/adapter.ts:28` — Connecting again abandons the previous connection.**  
   `current` is replaced without disconnecting its previous value. Two successful `connect()` calls followed by `disconnect()` closed only the second link in the probe. The first retains its socket and loss listener, which can later emit misleading events. Concurrent lifecycle calls can also overwrite one another. **Fix:** serialize lifecycle operations and either reject an already-connected call or explicitly replace and close the previous connection.

8. **`packages/adapter/src/hook-source.ts:47` — Popup document identity depends on reading the private hook.**  
   In the documented reused-`about:blank` context case, rollover occurs only when `ensure()` runs through the hook getter or a DOM event. An ordinary popup’s initial console/error events can therefore retain the `about:blank` document ID through `packages/adapter/src/capture.ts:115`. The fixture masks this by explicitly reading the getter in `apps/fixture/public/routes/popup-child.html:6`. **Fix:** drive identity rollover from collector-observed document lifecycle, and test a popup that logs immediately without accessing `__recnrunHook`.

9. **`tests/browser/profiles.spec.ts:123` — Actor isolation is implemented inside the test.**  
   The test selects the binding and invokes its own `drive()` helper. Production `packages/engine/src/replay.ts:153` ignores `step.actor` and sends every step to one driver. A two-actor probe consequently reported `passed` while using the same driver for both actors. This does not substantiate the capability claim that each actor runs on its binding. **Fix:** exercise production binding-aware dispatch; until supported, reject multi-actor execution explicitly and narrow the capability claim.

10. **`packages/adapter/src/instrumentation.ts:217` — Instrumentation startup failure leaks its owned channel.**  
    After opening the socket, `instrument()` returns `instrumentChannel()` without cleanup if initial auto-attach fails at line 199. The caller receives no handle with which to stop it. A rejected-auto-attach probe confirmed the channel remained open. **Fix:** close the owned channel when initialization rejects, including cleanup of any partially started capture work.

11. **`packages/persistence/src/journal.ts:79` — Journal error paths leak file descriptors.**  
    If `handle.sync()` fails, `handle.close()` is skipped; I reproduced this with a controlled sync failure. Initialization also leaves the opened handle behind if tail recovery fails at line 65. Repeated failures can exhaust descriptors. **Fix:** close on initialization failure and use `finally` during shutdown while preserving the original error.

12. **`packages/adapter/src/function-locator.ts:98` — A late async locator result escapes handle cleanup.**  
    On a caller-owned session, a timed-out promise can resolve after `releaseTransient()` has released its object group. The eventual successful reply is ignored: only rejection gets a handler. Its newly created remote handle then survives even if the caller already invoked `release()`. A delayed-reply probe demonstrated this ordering. **Fix:** handle successful late completion and release its group again; test completion occurring after both timeout cleanup and caller release.

13. **`packages/adapter/src/capture-network.ts:217` — Increasing the body limit silently drops body events.**  
    `maxBodyLength` is unrestricted, but `packages/protocol/src/capture.ts:100` caps inline bodies at 65,536 characters. With `maxBodyLength: 100000`, a 70,000-character response generated no body event and incremented the dropped counter. **Fix:** validate or clamp the option against the protocol limit, or change the schema and storage contract together.

14. **`packages/adapter/src/cdp-socket.ts:102` — Opening the instrumentation socket has no application deadline.**  
    Before `open`, only `error` rejects the promise; there is neither a timeout nor a `close` handler. A socket that never completes its handshake leaves instrumentation or endpoint-based locator resolution pending, outside the locator’s timeout. A close-only fake socket also left the promise unresolved. **Fix:** add a bounded opening timeout and close/error cleanup, clearing the timer when opening succeeds.

## Low

15. **`packages/protocol/src/capability-surfaces.ts:236` — Worker gap reporting is claimed but not implemented.**  
    The generated `docs/CAPABILITIES.md:35` says already-running dedicated workers are reported as gaps. Current instrumentation records them as `late`; capture emits an attached-target event, and the browser test checks observation/resumption rather than gap production. Consumers cannot rely on the stated loss accounting. **Fix:** describe the current report-only behavior or implement and assert explicit gaps before making that claim.

I exercised the findings with read-only Node/VM probes and simulated CDP/filesystem failures; no files changed. Chrome, real filesystem permissions, and the Docker/full verification gate were not exercised because this sandbox cannot create their required profiles, files, or artifacts.

Verified and found correct:

- Installation commands place the hook and binding before resume.
- Observer messages claiming the wrong target are dropped and counted.
- Cardinality selection, ordered journal appends, and recovery across a 70 KB truncated tail passed the in-memory checks.
- Replay stops after an adapter error; Markdown link checking passed.
