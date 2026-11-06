# Manual validation

Everything in [PLAN.md](PLAN.md) that needs a person. The owner authorized Claude to drive the installed Google Chrome on this Mac, including the personal Default profile (PLAN.md decision 3), so most host cells are automated host runs recorded in [CHECKLIST.md](CHECKLIST.md). What remains here is what no runner can do: the `Load unpacked` gesture in the personal Default (Chrome 137 removed `--load-extension` from branded builds and `chrome://extensions` is not scriptable), an OS login, a machine sleep, a Windows machine, and a Web Store publication. Record the date, machine, OS, Chrome version, build hash, and result under each item; a failed item opens a regression spec before anything else.

## After P1

- **M-P1.a Install in the personal Default and toggle file access.** With the `poc-d0` build: `chrome://extensions`, Developer mode, `Load unpacked`; record the permission texts on the card, the extension id (must equal the pinned id), `isAllowedFileSchemeAccess()` from the diagnostics page before and after "Allow access to file URLs", and the number of gestures. This is the manual install the source allows in every variant (§1.1); the toggle is a gesture that fails V1's "install only" criterion and is counted as such (§1).
  Result: pending the owner (2026-11-04). Claude cannot drive the native file picker that `Load unpacked` opens, so this item was not attempted by the orchestrator; the build is `apps/extension/.output/chrome-mv3-poc-d0` after `vp run build:poc`. Gate P1 closed without it (CHECKLIST.md resume protocol rule 8).

## After P2

- **M-P2.a E2.location.default on the host.** The host twin no longer runs it: with no download folder set, `poc-d0`'s install-time presence would land in `~/Downloads/RECnRun/poc/lab/peers/`, outside the subtree host runs may write. The owner may run it by hand on a throwaway root (no `download.default_directory` in its `Preferences`), record the learned root and the files written, then delete `~/Downloads/RECnRun/poc` and the probe files.
  Result: …

## After P3

- **M-P3.a Try the Downloads mesh by hand.** Three throwaway Chrome roots on this Mac, no Docker, no Playwright, never the personal profile and never `~/Downloads`. Each step names the terminal it runs in; a new terminal inherits nothing, so paste this line first in every terminal you open below (`<checkout>` is this repository's folder):
  ```sh
  cd <checkout> && REPO=$PWD && T="$HOME/Documents/RECnRun/poc-downloads-launcher/roots/try" && DL="$T/downloads"
  ```
  1. Build `poc-d0` (output `apps/extension/.output/chrome-mv3-poc-d0/`, which holds `manifest.json`):
     ```sh
     cd "$REPO" && vp run --no-cache extension#build:poc-d0 && ls apps/extension/.output/chrome-mv3-poc-d0/manifest.json
     ```
  2. Make the roots. All three pin `download.default_directory` to ONE stand-in Downloads folder, because the rendezvous is the Downloads folder: each profile writes its presence there through `chrome.downloads` and reads the others' back through `file://`, and the launcher scans that one root. Roots with their own folders never see each other. The `Preferences` are the shape `writeDownloadsPreference` (`tests/host/fixtures/roots.ts`) writes:
     ```sh
     for p in "$HOME/Documents/RECnRun" "$HOME/Documents/RECnRun/poc-downloads-launcher" "$HOME/Documents/RECnRun/poc-downloads-launcher/roots" "$T"; do
       [ -L "$p" ] && echo "$p is a symbolic link: stop, the recipe writes only under real folders"
     done
     mkdir -p "$HOME/Documents/RECnRun/poc-downloads-launcher/roots" && mkdir "$T" && touch "$T/.recnrun-host-root" || echo "$T exists: finish step 8 of the earlier try first"
     for n in alpha beta gamma; do
       mkdir "$T/$n" "$T/$n/Default" || break
       printf '{"download":{"prompt_for_download":false,"default_directory":"%s","directory_upgrade":true}}' "$DL" > "$T/$n/Default/Preferences"
       python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$T/$n/Default/Preferences"
     done
     mkdir -p "$DL/RECnRun/poc/lab"
     ```
     `mkdir` without `-p` makes the run folder and each root exclusively: an occupied `try/` is never reused and no `Preferences` of a profile that may be running is overwritten; the marker `.recnrun-host-root` is what step 8 removes by. The last line creates the folder `catalog.sh` writes into (it exits 73 on a missing output folder). `lab` is the namespace every `poc-d0` build uses (`DEFAULT_NAMESPACE` in `src/p2p/downloads-rendezvous.ts`; a stored override is not set here).
  3. Launch the installed Google Chrome on each root, each in its own terminal (the three commands differ only in the name). `--use-mock-keychain` keeps Chrome off the macOS keychain, so a throwaway root asks for no password and touches no real credential (`tests/host/fixtures/host-chrome.ts` passes it for the same reason):
     ```sh
     "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --user-data-dir="$HOME/Documents/RECnRun/poc-downloads-launcher/roots/try/alpha" --no-default-browser-check --use-mock-keychain
     ```
  4. In each Chrome: `chrome://extensions`, Developer mode, `Load unpacked`, choose the `chrome-mv3-poc-d0` folder (a counted gesture, as M-P1.a says). The card reads "RECnRun" with id `omllgeochjfpkjbkpcgjmnnbncdpiedd` (pinned by the manifest key). The extension reads the peers through `file://`; an unpacked install has that access from the start (E1.unpacked.default, lab and host: `isAllowedFileSchemeAccess()` true with no gesture, pref `newAllowFileAccess: true`), so leave "Allow access to file URLs" alone and check `chrome-extension://omllgeochjfpkjbkpcgjmnnbncdpiedd/diagnostics.html`: `fileSchemeAccess` is `true`. Gestures so far: Developer mode and `Load unpacked`, per profile. Within about 10 s of the install the extension writes its first presence into the stand-in Downloads folder (step 7); Chrome may show a download bubble, which is fine.
  5. Run the stand-in launcher in a fourth terminal. The record names the shared root and nothing else (the extension learns the root from Chrome; `downloads-profiles.ts` writes the same one block). `catalog.sh` writes back a `root=r1` line, and rewrites `registry.json` from the presences it finds, so the loop reruns it every 2 s as the E5 fixtures do:
     ```sh
     printf 'downloadsRoot=%s\n' "$DL" > "$T/record"
     while true; do
       sh "$REPO/scripts/poc-cross-profile/catalog.sh" "$T/record" lab "$DL/RECnRun/poc/lab" || echo "catalog.sh exited $?" >&2
       sleep 2
     done
     ```
     A line "skipped … invalid …" on stderr names a presence the catalog refused and why; an empty `peers` in `registry.json` with all three Chromes installed means the presences are not there yet.
  6. In each profile open `chrome-extension://omllgeochjfpkjbkpcgjmnnbncdpiedd/dashboard.html`. Within a minute it lists the other two profiles by name with a link state moving to connected, and their tabs; "Pair with other profiles" is not needed (the Downloads rendezvous pairs by itself). What works at Gate P3: presence, peers, tabs, Disconnect, Reconnect and Forget on a peer, the pair-again after Forget, and the hierarchy refusals. What does not: Record on another profile. Without a recorded hierarchy every profile's role defaults to `worker` (`roleOf` in `src/p2p/roles.ts`), so `mayControl` is false for every peer (`controls` in `roles.ts`: only itself and the workers it bound), the dashboard's Record control is gated on it (`useMayControl` in `src/views/use-peer.ts`), and a `session-start` sent anyway is refused by the receiver as "not the bound master" (`authorizeOrder` in `src/p2p/authorization.ts`, since `provesMaster` needs a `worker` binding). The binding today comes only from `bindHierarchy` (`tests/e2e/fixtures/hierarchy.ts`), the e2e fixture standing in for the launcher record, and from the P5.3 bootstrap; neither is reachable by hand. Driving Record by hand arrives with P4 (the launcher writes the hierarchy) and P5 (bases and bootstrap), see [PLAN.md](PLAN.md).
  7. Observe, in a fifth terminal:
     ```sh
     find "$DL/RECnRun" -type f | sort
     cat "$DL/RECnRun/poc/lab/registry.json"
     ```
     Each profile has `peers/<uuid>/presence.json`, rewritten about every 30 s (watch its `createdAt` move); `offer-<uuid>.json` and `answer-<uuid>.json` signals appear once per pairing; `registry.json` lists the three. The diagnostics page of each profile shows the report with `fileSchemeAccess`.
  8. Clean up. Quit each Chrome you launched with Cmd+Q (never `pkill`), stop the loop with Ctrl+C, then:
     ```sh
     pgrep -lf -- "--user-data-dir=$T" && echo "a Chrome of this try is still running: quit it first" || { [ -f "$T/.recnrun-host-root" ] && [ ! -L "$T" ] && rm -rf "$T"; }
     ```
     This removes only the folder step 2 made and marked (the roots, the record, and the stand-in Downloads folder all sit under it), and only once no Chrome launched on it is left.
     Date, machine, OS, Chrome version, build hash, gestures counted: …
     Result: …

## After P4

- **M-P4.a Autostart after an OS login.** `sh scripts/poc-cross-profile/recnrun-launcher.sh autostart on <state-dir> <record> <namespace>` (absolute paths without spaces; `<state-dir>` an existing folder, `<record>` the launcher record), log out and back in (or restart), confirm the LaunchAgent started the launcher without a command and that `sh scripts/poc-cross-profile/recnrun-launcher.sh status <state-dir>` reports `launcher running`; then `sh scripts/poc-cross-profile/recnrun-launcher.sh autostart off <state-dir> <record> <namespace>` and confirm it did not start on the next login.
  Result: …
- **M-P4.b First run from the package (macOS).** Run `vp run poc:package` and copy `dist/poc-launcher/macos` to a folder whose path has no space (for example `~/recnrun-launcher`). Follow its `README.md` only: verify `MANIFEST`, then in a Chrome profile open `chrome://extensions`, turn on Developer mode, click Load unpacked and choose its `extension` folder, then run the README's first command from the folder. Record the gestures counted (the README says 4 per profile plus the command), every prompt macOS or Chrome showed, and whether the profile ended open (`sh recnrun-launcher status "$HOME/.recnrun/launcher"`).
  Result: …

## After P5

- **M-P5.a Install in the base by hand (V2).** `Load unpacked` of the same build into the base root opened by `create-base`; record the gestures. V3 (P6.2) replaces this step by the automatic installation; both results are kept.
  Result: …

## After P6

- **M-P6.a V3 end to end and the Default as master (CL16, CL01–CL15).** Owner's run after Gate P6 and P7 headless (owner, 2026-11-05). With the `poc-d0` build loaded unpacked only in the personal Default (M-P1.a) and `R=$HOME/.recnrun/launcher.record` holding the Default's master block: start the launcher loop on `R` (`sh scripts/poc-cross-profile/recnrun-launcher.sh start <state-dir> "$R" <namespace>`), open the Default's dashboard, type a bases folder under `$HOME/Documents/RECnRun/poc-downloads-launcher` and 2 in the Prepare workers section, press Prepare, and let the loop advance one step per pass; answer the template gesture when the step shows pending-action. Expect Done only when both clones appear linked, never for the template's ack (CL16). Then run the host twin of the clone matrix against those clones with the Default as master: `RECNRUN_HOST_ROOTS=... RECNRUN_HOST_BASES=$HOME/Documents/RECnRun/poc-downloads-launcher RECNRUN_HOST_RECORD="$R" vp run test:host -- tests/host/clones.spec.ts` (prerequisites on the P5.5 `host (run B)` line of [CHECKLIST.md](CHECKLIST.md)), and record the run id under `.artifacts/evidence/host/`. The personal Default is never killed, read, or copied by anything but the owner's own gestures.
  Result: …

## After P7

- **M-P7.a Headless clones with the Default as controller (T9).** Owner's run after P7, with the clones of M-P6.a (owner, 2026-11-05). Quit the clones, then open each one with `clone-open.sh ... headless` and confirm that `ps` shows `--headless` and no window appears. In the Default's dashboard, confirm each clone is listed as linked. In the dashboard's DevTools console, run `chrome.runtime.sendMessage({ type: "peer", request: { type: "open-tab", peer: "<clone profile id>", url: "https://example.com/" } })` for each clone; the clone's tab list then shows `Example Domain`, and Activate answers ok. Asking a running headless clone for headed exits 65 and leaves one main process. Record the open times, and whether every clone linked and answered. [E13.md](experiments/E13.md) has the lab result.
  Result: …

## After P9

- **M-P9.a Sleep and wake.** With the Default and two workers linked, close the lid (or `pmset sleepnow`) for two minutes, wake, and record from the diagnostics files the link repair time and that no opening loop occurred.
  Result: …
- **M-P9.b Windows.** Not executed in this round: no machine. The report says "not executed".
- **M-P9.c Packed distribution.** Not executed in this round: no Web Store test channel available (owner, 2026-11-03). The zip from P1.1 is kept for a later publication; the report says "not executed".
