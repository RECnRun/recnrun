# Thin worker POC: results

The answers to [PLAN.md](PLAN.md), filled at each gate from asserting tests and the owner checks of [MANUAL_VALIDATION.md](MANUAL_VALIDATION.md). Until then this file only reserves the table.

| ID  | Hypothesis                                                                                              | Decided by               | Verdict | Evidence |
| --- | ------------------------------------------------------------------------------------------------------- | ------------------------ | ------- | -------- |
| H1  | H-FSA: a file-access-off master holds the rendezvous folder through restarts with zero prompts          | `P1.master-fsa`, M-TW.1  |         |          |
| H2  | H-CONSENT: "Allow on every visit" is obtained in the onboarding session                                 | `P1.master-fsa`, M-TW.1  |         |          |
| H3  | H-DBG-HEADLESS: `chrome.debugger` drives headless clones with no debugging flag                         | P1.13                    |         |          |
| H4  | H-CSP: the five operations work under `script-src 'none'` with Trusted Types                            | P1.13                    |         |          |
| H5  | H-DLDIR: a download directory set through Chrome persists into clones                                   | `P1.base-download-dir`   |         |          |
| H6  | H-PIN: only the master key pinned at onboarding can command a worker                                    | P1.9, P1.14              |         |          |
| H7  | H-REJECT: forbidden origins, stale documents, and code-carrying commands are refused before any effect  | P1.14                    |         |          |
| H8  | H-DEDUPE: an acknowledged mutation is never repeated across restarts                                    | P1.15                    |         |          |
| H9  | H-UPDATE: a stopped clone takes a new worker with identity, pin, and ledger intact                      | P3.2, M-TW.8             |         |          |
| H10 | H-SKEW: N−1 and N+1 negotiate or fail with a typed reason before any effect                             | P4.1, P4.2               |         |          |
| H11 | H-HEADED: headed clones show no infobar and report DevTools contention                                  | P5.1, P5.2, M-TW.3       |         |          |
| H12 | H-GESTURES: install to first result within the owner's gesture target                                   | P6.2, M-TW.4             |         |          |
| H13 | H-INSTALL: the one-line installer is idempotent, refuses bad downloads, and an AI review judges it safe | P6.6–P6.8, P6.10, M-TW.9 |         |          |
