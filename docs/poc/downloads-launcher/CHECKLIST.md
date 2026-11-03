# Checklist

Tracks [PLAN.md](PLAN.md). One line per task; the orchestrator owns `[x]`, implementers own `[i]`. This file is the resume point: a new session reads it and continues without the previous conversation.

## Resume protocol

1. Read [PLAN.md](PLAN.md) §1, §2, §4, and the section of the current phase; this file; [MANUAL_VALIDATION.md](MANUAL_VALIDATION.md); the experiment reports of the current phase under `experiments/`. Do not read the source document unless a task cites a section this plan does not restate.
2. The worktree is `.claude/worktrees/poc-downloads-launcher` of `/Users/dannyelcf/src/recnrun`, branch `poc-downloads-launcher`. `git status` is clean and `git log --oneline -1` matches **Last commit** below; otherwise stop and report. Run `vp install` after a pull.
3. Take the first task of the current phase that is `[ ]`. Do not start a later phase while an earlier one has `[ ]` or `[!]` tasks, unless the owner says so. P6 (V3) does not block the results of V1 and V2 and may run after P7 if the owner prefers.
4. Delegate (PLAN.md decision 9). Sonnet: ports, schemas, docs, generated reports. Opus: Docker, Chrome, launcher scripts, experiments. The orchestrator itself: gates, cherry-picks, Codex reviews, pushes, and every cell that touches the personal Default profile. Each brief lists the task IDs, a reading list of exact files (never "read the repo" or whole directories), the files the agent may change, the Docker commands and the throwaway roots it may use, and the cap on hand-backs. Agents work in their own worktree started at `poc-downloads-launcher` (`git reset --hard poc-downloads-launcher` then `vp install`) and are removed after the cherry-pick.
5. Implement with red/green and one commit per task (`.claude/agents/plan-implementer.md`). Mark `[i]` with indented `red:`, `green:`, and `commit:` lines. An experiment task records `verdict:` lines, one per hypothesis, with the environment. A host cell records a `host:` line with the run id under `.artifacts/evidence/host/` and the gesture counts.
6. A phase closes when the orchestrator runs `vp run verify` (exit 0), records the host cells the phase owns, obtains the Codex review (step 7), marks every task `[x]`, records the gate lines, pushes the branch (`GIT_SSH_COMMAND="ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=20"`, foreground, long timeout; the shared pre-push hook runs `vp run verify`), and updates the pull request against `poc/multi-profile-mesh`.
7. **Codex review before a phase closes.** `codex exec --ephemeral -s read-only -m gpt-6.1-sol -c model_reasoning_effort=high` with a prompt naming the commit range, the task IDs, and `AGENTS.md`. Evaluate every finding; apply the pertinent ones with red/green, one commit each; reject the rest with a reason; save the full text as `reviews/P<n>.md` (absolute paths turned into relative links); record `review:` on the gate line (date, findings, applied, rejected with reasons). A review that was not run blocks the gate.
8. Manual items are tracked only in [MANUAL_VALIDATION.md](MANUAL_VALIDATION.md); never mark a task `[x]` on the strength of a manual check.
9. Pausing: before the session ends, update **Last commit**, **Current phase**, and the **Paused** note below with what is in flight (agent worktrees and their branches, background runs and their logs, unpushed commits), then push if the gate allows. Memory of the orchestrator points here; the conversation is not the record.

Markers: `[ ]` not started · `[i]` implemented, awaiting the phase gate · `[x]` verified by `vp run verify` · `[!]` blocked (reason indented) · `[~]` partial (what is missing indented).

**Branch:** `poc-downloads-launcher` (from `60989d6`, head of PR #19 `poc/multi-profile-mesh`)
**Last commit:** the commit whose subject is "Plan the Downloads, launcher, headless, and cloning POC" (no hash: the commit cannot name itself)
**Current phase:** P0 (start with P0.1)
**Paused:** 2026-11-03, plan committed, nothing in flight. Owner decisions recorded in PLAN.md decisions 1, 3, 4, 9 (host Chrome allowed including the personal Default; packed not executed; §13 order; PR against `poc/multi-profile-mesh`).

## P0: Base, lab, baseline, and Chromium inventory

- [ ] P0.1 Plan documents and `docs:check`
- [ ] P0.2 Baseline of the base (verify counts, Google Chrome Stable in Docker, mesh regressions)
- [ ] P0.3 Browser and experiments layers on branded Chrome, E0 install methods, report `experiments/E0.md`
- [ ] P0.4 Chromium inventory `CHROMIUM.md`
- [ ] P0.5 Host runner `vp run test:host`
- [ ] P0.6 Namespace and evidence schema

Gate P0: verify · baseline counts · Chrome versions (lab, host) · review

## P1: Downloads write and `file://` read

- [ ] P1.1 POC build variants `poc-d0`, `poc-d1`, `poc-d2`
- [ ] P1.2 Clean install and the file-scheme state, E1 (lab, host)
- [ ] P1.3 Probe write and real path, E2 (lab, host)
- [ ] P1.4 Read in page and offscreen, E3

Gate P1: verify · E1–E3 · review

## P2: Discovery without a picker

- [ ] P2.1 Bootstrap of the catalog, E4 (lab, host)
- [ ] P2.2 Registration without a prior choice
- [ ] P2.3 Registry schema and launcher record

Gate P2: verify · E4 · review

## P3: Transport adapter and roles

- [ ] P3.1 Transport interface and Downloads adapter
- [ ] P3.2 Handshake over Downloads, E5 (lab, host)
- [ ] P3.3 Trust and pins
- [ ] P3.4 Roles and command authorization
- [ ] P3.5 Master absent and master back, E6
- [ ] P3.6 Presence cost, E7

Gate P3: verify · E5–E7 · review

## P4: Native launcher

- [ ] P4.1 Script harness (`vp run test:scripts`, ShellCheck, package scan)
- [ ] P4.2 Discovery of Chrome, roots, and profiles, E8 (lab, host)
- [ ] P4.3 Open request and token ack (lab, host)
- [ ] P4.4 Idempotence, timeouts, locks, pause policy, E9
- [ ] P4.5 Commands and autostart
- [ ] P4.6 Package and first run (host)

Gate P4: verify · E8–E9 · host cells · review

## P5: Clean base and graphical cloning on macOS

- [ ] P5.1 Base creation and freeze (CL01, CL02)
- [ ] P5.2 Transactional copy (CL03, CL15)
- [ ] P5.3 Template, bootstrap page, identities (CL04, CL06, CL07)
- [ ] P5.4 Diagnostics page
- [ ] P5.5 Matrix CL05, CL08–CL12, three rounds
- [ ] P5.6 Unpacked code dependency and base update (CL13, CL14)

Gate P5: verify · CL01–CL15 over three rounds · review

## P6: Onboarding with the extension installed only in the Default

- [ ] P6.1 Onboarding flow
- [ ] P6.2 Automatic persistent installation of the base, E10 (CL17)
- [ ] P6.3 V3 end to end (CL16)

Gate P6: verify · CL16, CL17 · review

## P7: Silent and headless execution

- [ ] P7.1 Headless lab runner `vp run test:headless`
- [ ] P7.2 T1–T3 one root, visible and `--no-startup-window`, E11 (lab, host)
- [ ] P7.3 T4–T5 one root, headless attempt, E12 (lab, host)
- [ ] P7.4 T6–T8 separate roots, headless workers, E13 (lab, host); T9 headless on clones

Gate P7: verify · E11–E13 · review

## P8: With and without `chrome.debugger`

- [ ] P8.1 D2 operation
- [ ] P8.2 Variant comparison, E14 (lab, headless, host)
- [ ] P8.3 Clones per variant (host)

Gate P8: verify · E14 · review

## P9: Matrix, metrics, report, and decision

- [ ] P9.1 Soak and repetition (`vp run test:soak`, host soak)
- [ ] P9.2 Mandatory cases mapped
- [ ] P9.3 `RESULTS.md` and document updates

Gate P9: verify · push · pull request updated · review
