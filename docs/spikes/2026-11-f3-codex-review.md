# Codex review of F3 (2026-11-03)

Review of `git diff 8fd1ff1...acfbaaf` (branch `f3-diagnostics` against `f2-vertical`) by Codex with `gpt-6.1-sol` at high reasoning, read-only, as step 5 of the [checklist protocol](../plan/CHECKLIST.md#resume-protocol). The orchestrator's decisions are in the checklist's F3 `review:` line.

**Request changes.** The diff has concrete failures in secret redaction, durable delivery, crash recovery, connection-loss handling, and capture shutdown. Run comparison can also report application differences caused by collection or response ordering. I reproduced the principal failure paths with in-memory probes; the existing verify-configuration checks pass, but they do not cover these cases.

## Critical

None identified.

## High

1. **`packages/engine/src/replay/snapshots.ts:31` — HTML serialization bypasses secret redaction.**  
   Redaction searches serialized HTML for the literal secret. A secret such as `p&<ss` appears in `DOM.getOuterHTML` as `p&amp;&lt;ss`, survives replacement, and is persisted and displayed intact. I reproduced this through `snapshotter`. Redact decoded DOM text and attribute values before safely serializing them, and add cases containing HTML metacharacters.

2. **`packages/adapter/src/observer-delivery.ts:88` — ACKs confirm receipt before persistence.**  
   `arrive()` immediately accounts for a message and schedules its ACK. Capture subsequently calls a `void` sink; journal writes remain asynchronous in `record.ts:189`. A slow disk therefore moves the backlog into an unbounded collection of pending writes while the page discards acknowledged messages. A crash can lose acknowledged evidence. Make acknowledgement depend on successful durable persistence, preferably in bounded batches, and propagate write failures.

3. **`packages/persistence/src/recovery.ts:50` — Recovery trusts a potentially stale index and can overwrite completed runs.**  
   Result files are written before the SQLite update in `flow-writes.ts:144`. A crash between those operations leaves a completed run indexed as `running`; recovery ignores its existing summary and replaces it with an interrupted result. Conversely, a crash between creating the run folder and indexing it leaves a run recovery never discovers. Reconcile the index against run folders before recovery, and preserve valid completed results.

4. **`packages/adapter/src/replay-observer.ts:66` — Losing the evidence socket silently stops collection.**  
   Replay uses a separate CDP channel for evidence, but `CdpChannel` exposes no closure notification. Its `close handler` only rejects pending commands; the engine watches the separate Playwright connection. I simulated closing the evidence socket after adoption: `drain()` succeeded with no collector gap. Expose unexpected channel closure and persist a gap while settling the affected capture work.

5. **`packages/adapter/src/replay-observer.ts:101` — Drain waits for polling to finish before stopping polling.**  
   `instrumentation.settled()` waits until its pending set becomes empty, while cookie polling continues scheduling reads. In `capture-cookies.ts:114`, each completed slow read can immediately start its queued successor. With reads slower than the polling interval, drain never finishes even though every individual request completes. Storage reads also have no deadline. I reproduced the continuously pending drain. Quiesce producers first, then drain outstanding work with deadlines and explicit failure accounting; apply the same fix to session shutdown.

6. **`packages/engine/src/replay/executor.ts:173` — Connection loss cannot interrupt a paused replay.**  
   The loss check runs before `mayStart()`, which waits only for `control.changed()`. Killing Chrome while `pauseReplay` holds leaves replay pending indefinitely. I reproduced this using a session created and paused through the actual session state machine. Race the pause wait against `interruption.next`, cancel remaining steps on loss, and recheck interruption before dispatch after a resume.

7. **`packages/engine/src/replay/record.ts:90` — Loss after the final action can still produce a successful run.**  
   Overall interruption is inferred exclusively from step results. If Chrome disconnects during the final after-snapshot or evidence drain, all steps can already be `passed`. My probe produced `status: "passed"`, exit code `0`, and a persisted `connection-lost` gap together. Track connection loss independently in the recorder and make the run interrupted, preserving steps that passed before the loss.

## Medium

8. **`packages/engine/src/replay/evidence.ts:6` — Recursive redaction corrupts structural payload fields.**  
   `redactDeep()` replaces secrets in hashes, correlation IDs, encodings, and enum values as well as captured content. With the valid secret `"a"`, a body’s `"captured"` condition and SHA-256 are modified. I verified that a valid network event then fails `NetworkEventSchema` and `BodyRefSchema`; diagnostics drops it and artifact lookup cannot recognize its reference. Use schema-aware redaction of content fields, preserving structural metadata, and validate the resulting specialized event.

9. **`packages/adapter/src/capture-network.ts:223` — Closing a target abandons tracking of an active blob write.**  
   The tracked promise races the entire body operation, including `blobs.put()`, against `entry.abandon`. Closing capture resolves abandonment even when the blob write is already underway. I reproduced an empty pending set while the blob sink remained unresolved. Run completion can therefore precede outstanding file work and leave an orphan blob. Track browser reads and blob writes separately, retaining writes in the drain until completion.

10. **`packages/engine/src/replay/snapshots.ts:75` — Snapshot persistence errors abort replay.**  
    `tryCapture()` catches browser errors, but `blobs.put()` failures escape. A successful click followed by an unwritable or corrupt blob destination aborts before `step.finished` is journaled; subsequent recovery can classify that completed write as indeterminate. Injecting a rejecting blob sink reproduced the escaping error. Convert each failed snapshot part to `unavailable` and preserve the action’s outcome.

11. **`packages/adapter/src/replay-capture.ts:74` — The snapshot deadline does not bound the CDP session’s lifetime.**  
    If `newCDPSession()` resolves after its deadline, the returned session is never detached. Separately, `captureWith’s cleanup` awaits `detach()` without a deadline, allowing snapshot capture to hang indefinitely. I reproduced both conditions. Use one deadline for the whole operation, arrange cleanup for late session creation, and bound detachment.

12. **`packages/persistence/src/run-compare.ts:129` — Response completion order determines request pairing.**  
    Responses are paired by endpoint and their response-arrival ordinal, without consulting their requests. Concurrent `GET /items` → 200 and `POST /items` → 201 can complete in opposite orders across equivalent runs, producing a false application `network-status` divergence. I reproduced the reordered-status mismatch. Join responses to requests first, then align by method, endpoint, and request occurrence; test reversed completion order.

13. **`packages/persistence/src/run-compare.ts:113` — Matching gap reasons conceal materially different collection losses.**  
    `unmatchedGap()` treats gaps as equivalent solely by reason and occurrence. A baseline losing one DOM event and a run losing 100 network events both match as `buffer-exhausted`; comparison can then blame a later assertion on the application. I reproduced that classification. Compare normalized gap details, including surface and loss extent, and retain collector uncertainty when the gaps differ.

14. **`scripts/git-hooks/pre-push.mjs:7` — The verify cache checks HEAD instead of the commits being pushed.**  
    The hook never reads Git’s ref-update input. From a clean, verified checkout of commit A, `git push origin unverified-branch:feature` can push commit B while skipping verification because A has a marker. Read the pushed local SHAs and require verification for those exact commits, including multiple-ref pushes; otherwise verify them in appropriate worktrees or reject unsupported refspecs.

## Low

None identified.

Verified correct:

- `node --test tests/container/verify.checks.mjs`: **3 passed**, confirming gate enumeration and test-project deduplication.
- In-memory probes confirmed case-insensitive sensitive-header redaction, omission of HttpOnly/Secure cookie values, blob traversal rejection before I/O, and positional pagination remaining stable after appends.
- Static inspection confirmed the viewer’s empty iframe sandbox, CSP placement before captured markup, and absence of an added `innerHTML` execution sink.
- Failure probes reproduced the reported redaction, interruption, comparison, socket-loss, drain, and snapshot-lifetime defects. Docker/browser suites and full `vp run verify` were not run because this workspace is read-only and those commands generate artifacts.
