# POC checklist: sequential Incognito sessions

Plan: [poc-incognito-sessions-plan.md](poc-incognito-sessions-plan.md). Assignment: [poc-incognito-sessions-assignment.md](poc-incognito-sessions-assignment.md). Report: `docs/POC-ORIGIN-SNAPSHOT.md`.

| Item                 | Value                                                            |
| -------------------- | ---------------------------------------------------------------- |
| Worktree             | `/Users/dannyelcf/src/recnrun-incognito-sessions-poc`            |
| Branch               | `poc/incognito-sessions`                                         |
| Planned base         | `44c154da29860c7a8df829e902b177df5ce2ba2a` (2026-10-28)          |
| Actual base (P0.1)   | _pending_                                                        |
| Last recorded commit | _none yet (plan files uncommitted)_                              |
| Decisions OD-1…OD-4  | defaults of plan §3, accepted by the user ("Avance", 2026-10-28) |

## Status legend

`[ ]` not started · `[i]` implemented and committed, awaiting the stage's `vp run verify` · `[x]` verified by the orchestrator · `[!]` blocked (reason on the line) · `[~]` partly done (what is missing on the line) · `[manual]` needs the user

## Resume protocol

1. `cd /Users/dannyelcf/src/recnrun-incognito-sessions-poc`; `git status` must be clean.
2. `git log --oneline -5`: the newest commit must be **Last recorded commit** above, or a checklist-only commit (`Record … in the POC checklist`) directly on top of it. Otherwise stop and reconcile before changing anything.
3. Read the plan section of the first task that is not `[x]`, and its evidence lines here.
4. Check the stop gates: do not start a task after an unpassed gate (G1, G2) without the user's go-ahead recorded under that gate.
5. After each task commit: add `red:`, `green:`, `commit:` lines under it, mark `[i]`, update **Last recorded commit**, and commit the checklist alone (`Record <task> evidence in the POC checklist`), since a commit cannot hold its own SHA.
6. At the end of a stage: run `vp run verify`, record the run id under the stage, mark the stage's tasks `[x]`.

Evidence format under each task:

```text
  red:    <command> → <quoted failure>
  green:  <command> → <result>
  commit: <sha> <subject>
  notes:  <exercised / not exercised and why>
```

## Stage 0 — Setup and reconnaissance

- [ ] P0.1 Baseline: `vp install`, re-resolve `origin/master`, versions, baseline `vp run verify`, report skeleton
- [ ] P0.2 Platform facts in a scratch copy (structured clone, runtime content script, DNR in Incognito, cookie stores)
- [ ] P0.3 Fixture server (`/sentinel`, `/inspect`, `/sw.js`, logs) + second `webServer` + `POC_REPEATS` forwarding

Stage 0 verify: _pending_

## Stage 1 — Native context reset

- [ ] S1.1 Domain: `ManagedWindowState`, `classifyIncognitoWindows`, `isAllowedTarget`
- [ ] S1.2 Background: `inventory`, `closeWindows` (waits for removal), `createNeutralWindow` (refuses when any Incognito window exists), state repository
- [ ] S1.3 Workspace commands, `OWN_PAGE` routes, single-operation lock, stale `windowIds` refusal
- [ ] S1.4 Dashboard: access requirement, blockers + "Close these windows and start", Start, "Use this tab's address"
- [ ] S1.5 Record only the managed tab; existing e2e and product docs updated
- [ ] S1.6 E2E reset experiment (six sentinel kinds, normal profile unchanged, repository readable) + negative control (foreign window keeps data, dashboard blocks)
- [ ] S1.7 Stress loop (`POC_REPEATS=50`), teardown signal if survivors, report section

Stage 1 verify: _pending_

### Gate G1 — native reset

- [ ] Report section and verdict written
- [ ] User go-ahead for Stage 2: _pending_

## Stage 2 — Restore before application bootstrap

- [ ] S2.1 Conventional fixture app `/app/` + plain Incognito baseline
- [ ] S2.2 Test/dev permissions (`declarativeNetRequest`, `scripting`, `cookies`, `webNavigation`, fixture hosts) + test-manifest guard; production unchanged
- [ ] S2.3 Barrier module (append CSP, block subresources, bound redirects, register agent; verified removal)
- [ ] S2.4 Origin agent (validated port, structured clone, transaction completion) + dependency rule + ARCHITECTURE
- [ ] S2.5 Bootstrap sequence (cookie store from tab, cookies by `storeId`, barrier, restore, remove, reload same tab)
- [ ] S2.6 E2E barrier proof at 0 ms and 2,000 ms (`POC_REPEATS=50`), site CSP kept, network bounded; scratch negative control
- [ ] S2.7 Operation journal + failure paths (restore failure, tab closed, extension reload) with cleanup

Stage 2 verify: _pending_

### Gate G2 — startup barrier

- [ ] Report section and verdict written
- [ ] User go-ahead for Stage 3: _pending_

## Stage 3 — Snapshot fidelity and consistency

- [ ] S3.1 Domain `IdentityCapture` v1
- [ ] S3.2 Capture repository in extension IndexedDB with atomic publish (+ `unlimitedStorage`)
- [ ] S3.3 IndexedDB adapter, full schema and keys, `autoIncrement` case
- [ ] S3.4 Transport fidelity round trip (+ scratch negative control without `message_serialization`)
- [ ] S3.5 localStorage and sessionStorage adapters
- [ ] S3.6 Cookies adapter (all attributes, prefixes, partitioned)
- [ ] S3.7 Cache Storage adapter with `unsupported` classification
- [ ] S3.8 Full lifecycle coordinator (switch, suspend, resume, new, delete; commit before close; stale drops)
- [ ] S3.9 Dashboard identities, persistence note, delete, conflicts, failures
- [ ] S3.10 Writers during capture (page, worker, Service Worker) and the consistency boundary
- [ ] S3.11 Lifecycle E2E suite (A→B→A→C→A ×10, failures, restarts, stale messages, concurrency, 10,000 records)

Stage 3 verify: _pending_

### Gate G3 — data fidelity and capture consistency

- [ ] Report section and verdicts written (stop only on NO-GO)

## Stage 4 — PWA compatibility and Zephyr

- [ ] S4.1 PWA fixture `/pwa/` + native Incognito baseline
- [ ] S4.2 PWA through A→B→A→C→A (first load, controlled reload, version change, offline cases)
- [ ] S4.3 Declared capability: additional cookie hosts (fixture SSO)
- [ ] [manual] S4.4 Zephyr build, `vp run poc:zephyr`, runbook; user runs baseline and A→B→A→C→A
- [ ] S4.5 Zephyr results and verdict ("not validated" without the user's run)

Stage 4 verify: _pending_

## Stage 5 — Delivery

- [ ] D.1 Timings aggregated (capture, transport, persistence, teardown, bootstrap, restore, PWA readiness, total; 10,000-record size)
- [ ] D.2 Durable docs (ARCHITECTURE, PRODUCT_BRIEF, POCS, TROUBLESHOOTING)
- [ ] D.3 Report complete with six verdicts and recommendation
- [ ] D.4 `vp run verify` exit 0: _run id pending_

## Optional

- [ ] C.1 Reused Incognito context comparison (only with the user's go-ahead after G3)

## Parallel-safe pairs

- P0.2 and P0.3 (P0.2 works in a scratch copy).
- S1.1 and the fixture pages of S2.1 do not touch the same files, but S2.1 waits for Gate G1 by rule.
- S3.5, S3.6, S3.7 after S3.4, if each implementer works in its own worktree and the orchestrator merges in order.

## Gate decisions log

| Date | Gate | Verdict | User decision |
| ---- | ---- | ------- | ------------- |
