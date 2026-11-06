# Thin worker POC: manual validation

Checks that need the owner's Mac, the real Chrome Web Store, or a person's judgment. Only the orchestrator or the owner runs them; agents never open host Chrome. A check on the personal Default profile runs only after it passes on a throwaway root.

Record each result under its check as `Result: <date> · <machine, OS> · Chrome <version> · build <commit> · run <id> · pass | fail · <notes>`. Store screenshots and logs under `.artifacts/evidence/host/<run id>/`; link the folder name, not the files. A failure becomes a task in [CHECKLIST.md](CHECKLIST.md).

## After Gate W

- **M-TW.12 Real origin.** Needs the owner's explicit authorization, because it publishes the lab page on recnrun.com through a push to `master`. Repeat `W.rtc` (variant `public`), `W.fsa` (tab), and `W.friction` against `https://recnrun.com` on the owner's Mac.
  Expected: as the lab cells; any Local Network Access or macOS Local Network prompt is listed with its gesture count.
  Result:
- **M-TW.13 `W.rtc` on macOS.** On a throwaway root, open the lab page from the stand-in run on the Mac, and link two clones (one headless) with no flag.
  Expected: both links up with `.local` page candidates kept; the selected candidate pair recorded; every prompt (Chrome's or macOS Local Network) listed.
  Result:
- **M-TW.14 `W.fsa` on macOS, tab and app.** On a throwaway root, onboard in a tab, then install the app with Chrome's own install button and onboard again in a second throwaway root. Close and reopen, then quit and relaunch Chrome twice.
  Expected: zero gestures after onboarding in both; same key thumbprint; the folder readable and writable. Repeat on the personal Default (orchestrator only).
  Result:
- **M-TW.15 Sleep during a job.** Start a job whose `wait` is held, close the lid for 5 minutes, then wake the Mac and reopen the page.
  Expected: the job ends on the worker or answers `TIMEOUT`/`EXPIRED`; the page reconciles with no resubmission; the fixture POST count is at most 1.
  Result:

## After P1

- **M-TW.1 `P1.master-fsa` on macOS.**
  1. On a throwaway root, load `poc-master` with file access off and turn on "Ask where to save" in `chrome://settings/downloads`.
  2. Run onboarding: choose `~/RECnRun/rendezvous`, then obtain "Allow on every visit".
  3. Provision a base, freeze it, and make two clones; quit Chrome. The launcher moves the workers' files into the rendezvous folder.
  4. Relaunch Chrome twice without opening any extension tab. Each time, check `chrome://inspect/#extensions` for the recreated offscreen document, ask for one provisioning and one clone-control operation from a terminal request file, and wait for both acks in the rendezvous folder and for the clones' new presence files.
  5. After the second run, quit Chrome and count the rows of the `downloads` table in the profile's `History` database (`sqlite3`).
  6. Repeat on the personal Default (orchestrator only).

  Expected: both clones pair after each relaunch with no extension tab; both acks arrive; no Chrome prompt; zero `downloads` rows; the frozen base is never listed in `registry.json`. Revoking the grant in site settings, then opening the dashboard, shows its recovery action.
  Result:

- **M-TW.2 Folder picker.** In onboarding, try `~/RECnRun`, `~/Documents`, `~/Downloads`, and a folder without the marker, then `~/RECnRun/rendezvous`.
  Expected: Chrome or the dashboard refuses the first four with a clear message; the last one is accepted. Record the gesture count.
  Result:

## After P5

- **M-TW.3 Headed clone with no infobar.** Open a clone headed on macOS and run the slice script.
  Expected: no "started debugging this browser" bar; the script completes; opening DevTools during an operation shows a typed error in the dashboard, not a silent retry.
  Result:

## After P6

- **M-TW.4 Onboarding gesture count.** From a Mac user account with Chrome and no RECnRun files, count every click, keystroke group, and prompt from pasting the install command to the first script result.
  Expected: at most the owner's target (proposed 6); each gesture is listed in the result.
  Result:
- **M-TW.5 Reboot recovery.** After onboarding, restart the Mac, log in, and open Chrome only.
  Expected: the dashboard shows both clones within 60 s with no terminal and no prompt.
  Result:
- **M-TW.6 Sleep and wake with a pending operation.** Start a long `wait`, close the lid for 5 minutes, then wake the Mac.
  Expected: the operation answers `TIMEOUT` or completes; no mutation is repeated (fixture POST count).
  Result:
- **M-TW.9 Owner's end-to-end run from recnrun.com.** The AI trust review is not an owner check; the orchestrator runs it (PLAN P6.10).
  1. Compare the served `install.sh` with its published SHA-256 and with the repository source.
  2. Run `curl -fsSL https://recnrun.com/install.sh | sh` on a clean user account, then run it again.
  3. Run it with `--uninstall`.

  Expected: no prompt in the terminal; the second run reports nothing to change; Chrome opens the onboarding. Uninstall leaves no file the installer wrote, and the personal Chrome profile is untouched (`ls -la` before and after).
  Result:

- **M-TW.10 macOS TCC probe for a Downloads rendezvous.** Install the launcher's autostart entry, point it at a test folder `~/Downloads/RECnRun/rendezvous`, log out and in, and let it list and write one file there.
  Expected (records the fact, either way): whether macOS shows a privacy prompt for `sh`, denies silently, or allows. Only "allows with no prompt" reopens the option rejected in PLAN decision 4.
  Result:
- **M-TW.11 Linux reboot recovery.** On a Linux desktop session (a VM is fine) with Google Chrome Stable, onboard, reboot, log in, and open Chrome only.
  Expected: as M-TW.5. Without this check, RESULTS says Linux reboot recovery is deferred.
  Result:

## After P7

- **M-TW.7 Store install.** When an unlisted Store channel exists, install the master from it into the personal Default and repeat M-TW.1 steps 2–4.
  Expected: as M-TW.1; the installed id equals the pinned master id.
  Result:
- **M-TW.8 Update existing clones on macOS.** With two clones on worker v1, install v2 with the one-line installer and let the launcher update the stopped clones.
  Expected: each clone reports v2 after its next start, with its identity and pin unchanged; a clone running during the install keeps v1 until stopped.
  Result:
