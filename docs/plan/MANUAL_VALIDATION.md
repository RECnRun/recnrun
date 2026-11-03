# Manual validation

Everything in [PLAN.md](PLAN.md) that needs a person: Chrome's own dialogs, the default profile, a second machine, a real agent session, or publishing. Each item runs after the automated gate of its phase and before the release gate (F7.4). Record the date, machine, OS, Chrome version, and result under the item; a failed item opens a regression (`regressions/<issueId>/`) before anything else.

Why these are manual: Chrome's permission dialog and the `chrome://inspect/#remote-debugging` toggle cannot be driven by the tool itself; the default profile is excluded from `--remote-debugging-port` since Chrome 136; Playwright cannot click native prompts; the Docker image is Linux.

## After F1

- **M-F1.a macOS, default profile.** On this machine (Chrome 156): enable remote debugging at `chrome://inspect/#remote-debugging`; run `recnrun doctor --json` and confirm `remoteDebugging: "found"` with the default `~/Library/Application Support/Google/Chrome`; connect; Chrome shows its permission dialog and, after acceptance, the "controlled by automated test software" banner; a page interaction appears in the journal. Record the dialog text and whether it repeats per session.
  Result: partial, 2026-11-02, macOS, Google Chrome 156.0.8078.76, default profile: the owner enabled remote debugging, accepted the permission dialog, and Chrome showed the "Chrome is being controlled by automated test software" banner with a "Turn off in settings" button (the connection came from an `apps/service` instance a host-side F2.1 test started, not from the CLI). Pending: `recnrun doctor --json` (F2.7), a page interaction in the journal, the dialog text, and whether it repeats per session.
  Result (Linux, automated): 2026-11-03, Google Chrome 156.0.8078.79 in the test container, `tests/desktop/first-use.spec.ts` (F3.10), `.artifacts/screens/F3.10/`. The dialog is titled "Allow remote debugging?" and says "An external app wants full control over this Chrome session to debug it. This includes access to your saved data, cookies and site data, and the ability to navigate to any URL." and "Only web developers should turn on this feature, and only use it with trusted apps.", with the buttons "Turn off in settings", "Cancel" (focused) and "Allow"; the banner afterwards reads "Chrome is being controlled by automated test software" with "Turn off in settings". It repeats once per CDP WebSocket, not per session: one recording with the picker and one replay showed it six times before F3.11 and four after it (the test's own connection, one socket per service process, and the replay's Playwright connection; `.artifacts/screens/F3.11/`). `chrome://inspect`'s toggle fixes the port at 9222. On the owner's Mac the first `doctor` was blocked by macOS app-data protection (fixed: `Chrome: blocked (unreadable-file)` names the Full Disk Access step); the macOS pass of this check is still pending.
- **M-F1.b Windows, default profile.** Same as M-F1.a on a Windows machine with Chrome Stable; `%LOCALAPPDATA%\Google\Chrome\User Data`.
  Result: …
- **M-F1.c Two profiles in one Chrome instance.** With the default profile and a second profile open in the same Chrome, confirm how targets of each profile are distinguished (`browserContextId` or otherwise), that the friendly-name binding survives a Chrome restart or asks for reconfirmation, and that no profile is picked by discovery order. Update F1.3 and the spike report with the proven strategy.
  Result: …
- **M-F1.d DevTools open.** Open DevTools on a tab, then connect (or reconnect) the tool; confirm it reports `control.contested` for that tab and never detaches DevTools. DevTools opened after the tool connected is not reported: CDP gives no signal for a second client ([ARCHITECTURE.md](../ARCHITECTURE.md#adapter)).
  Result: …

## After F2

- **M-F2.a A person records and replays.** On macOS with the default profile: create a flow in the UI, record navigation, fill, click on a real application, add an assertion with the picker, stop, quit the tool, reopen it, replay. No AI, no code. Note anything the UI did not explain (reload needed for startup capture, coverage gaps).
  Result (Linux, automated): 2026-11-03, `vp run test:desktop` (F3.10) drives the whole check on a fresh profile with `xdotool`: remote debugging turned on in `chrome://inspect`, the real `recnrun open`, a recording on the fixture form, the connection dialog accepted, an assertion through the picker, the service stopped and started again, a replay that survived a real click on its tab (the run ended 267 ms after it) and the run's diagnostics opened; screenshots under `.artifacts/screens/F3.10/`. Not explained by the UI: Chrome asks "Allow remote debugging?" at every new CDP connection (six times in this check before F3.11, four after it, which the test now asserts), and `recnrun open` exits 0 on SIGTERM.
  Result (macOS, the owner): …

## After F3

- **M-F3.a 30-minute soak.** `node --expose-gc scripts/soak-capture.mjs --minutes 30` on the pilot hardware: it starts the fixture and a Google Chrome on a fresh temporary profile (never the default one or `~/.recnrun`), records the burst route in Normal mode (`--modes` adds others), appends a line to `.artifacts/soak/<timestamp>/progress.jsonl` every minute (`--flush-seconds`), and writes `report.json` and `summary.md` at the end. Attach the report (loss, gaps, memory, trace size, and the 1 s UI progress measurement) to the phase pull request; heap or trace growth across the progress lines that does not level off is a regression.
  Result: …

## After F4

- **M-F4.a Colleague replays an imported flow.** Export the A-B-A flow; a colleague on another machine imports it, maps their own two profiles and `baseUrl`, provides credentials locally, and replays. No cookies or tokens travel in the package.
  Result: …

## After F5

- **M-F5.a Claude Code session.** After `recnrun agents setup --target claude-code`, in a new session: "Record the validation of this card in profile Main and save as Create order", "Start a recording; I will execute manually", "Run Create order with dataset scenario-01; if it fails, investigate". Confirm the MCP tools are listed, the skills trigger, the flow replays afterwards without the agent.
  Result: …
- **M-F5.b Codex session.** Same as M-F5.a with `--target codex`.
  Result: …
- **M-F5.c Skills load in both agents.** Before merging F5.3: Claude Code lists the four skills; `codex exec --ephemeral -s read-only "list the recnrun skills you can use"` names them. (Required by AGENTS.md for every skill change; run locally, not in Docker.)
  Result: …

## Before release (F7.4)

- **M-F7.a Windows clean install.** Colleague with Node 24 LTS and Chrome Stable, no clone, no build: `npx @recnrun/cli@<version> setup`, `doctor`, import a flow, `run`. Record Chrome's confirmations as shown.
  Result: …
- **M-F7.b macOS clean install.** Same as M-F7.a on macOS. Also confirm the service can read `~/Library/Application Support/Google/Chrome/DevToolsActivePort` without extra macOS permissions (a sandboxed process on this machine could not list that folder on 2026-11-02).
  Result: …
- **M-F7.c Publish.** `npm publish` of `@recnrun/cli` under the owner's account, after the scope exists; update, rollback, and uninstall exercised against the published version on both machines.
  Result: …

## Corporate environment (when a pilot machine has one)

- Node, npm, or remote debugging blocked by policy: record the exact block and the requirement to raise with IT. Not a defect of the tool.
