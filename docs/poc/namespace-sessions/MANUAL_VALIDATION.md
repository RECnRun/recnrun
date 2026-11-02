# Manual validation

Everything in [PLAN.md](PLAN.md) that needs a person: the branded Chrome on a desktop with its own profile, Chrome's dialogs and infobars, DevTools, a real third-party application, or the strict form of T23 where no runner and no observer exist. Each item runs after the automated gate of its phase and before the report is final (P8.2). Record the date, machine, OS, Chrome version, extension build hash, and result under the item; a failed item opens a regression spec (`tests/browser/regressions/<id>.spec.ts`) before anything else.

Why these are manual: Chrome 137 removed `--load-extension` from branded builds, so loading an unpacked extension into the person's own Chrome is a `chrome://extensions` gesture; the `debugger` infobar and the install warning are browser UI the harness hides or never shows; DevTools coexistence needs a person to open DevTools; a real Keycloak/Angular/Dexie application or a public PWA needs network egress the tests forbid; and T23 in its strict form forbids the very CDP connection a test runner uses.

## After P0

- **M-P0.a macOS, branded Chrome, unpacked load.** On this machine (Google Chrome 156, default profile): enable Developer mode at `chrome://extensions`, "Load unpacked" the `apps/isolator/.output/chrome-mv3` build, open the fixture (`vp run dev:fixture`), and confirm the extension's dashboard lists the environment. Record the install warning text for the `debugger` permission, whether the "RECnRun started debugging this browser" infobar appears, on which tabs, and whether closing it detaches the debugger (the extension must report the detach in its diagnostics).
  Result: …
- **M-P0.b Windows.** Same as M-P0.a on a Windows machine with Chrome Stable. If no machine is available, record "not validated on Windows" and the report says so.
  Result: …

## After P1

- **M-P1.a DevTools on a managed target.** With the extension attached to a fixture tab and its service worker, open DevTools on the tab and on the worker (`chrome://serviceworker-internals` → Inspect). Record what the extension's `chrome.debugger.onDetach` reports (`replaced_with_devtools` or otherwise), whether the bootstrap still won on the next worker start, and whether the extension recovered when DevTools closed.
  Result: …

## After P4

- **M-P4.a The person's own profile, Chrome restarted.** With the fixture's A and B sessions created in the default profile and unrelated personal tabs open: quit Chrome, reopen it with session restore on, and confirm the managed tabs come back parked (not executing A under B), personal tabs are untouched, and the dashboard shows the recovered state from the journal. Then repeat with Chrome killed from the OS (Force Quit).
  Result: …

## After P6

- **M-P6.a Representative Angular/Dexie/Keycloak application.** If the owner provides access to one: run T01 and T10 by hand against it (A → B → A), confirm server-side identity on each step from the application's own account page, confirm its service worker is still registered and serving offline. If no access is provided, record "lab equivalent only (`apps/fixture/lab/`)".
  Result: …
- **M-P6.b Non-adapted public PWA with a framework service worker.** Pick one public PWA (for example a Workbox-based one); install it as a PWA window; create B; confirm the PWA window is parked while B is active, the worker is re-instrumented on resume, offline still works. Egress happens only in this manual run, never in tests.
  Result: …

## After P7

- **M-P7.a T23, strict.** Build the package (`vp run isolator:zip`), load it in the person's Chrome, stop every dev server except the fixture (`vp run dev:fixture`), close every DevTools window, make sure no Playwright, CDP client, or `--remote-debugging-*` flag is in use (check `chrome://version` command line), and run original → B → original → C → original through the popup and dashboard only. Export diagnostics from the dashboard; confirm the fixture's ledger page (`/__ledger`) shows the right user per step and no original cookie on B's or C's first request. Record switch durations as the dashboard shows them.
  Result: …
- **M-P7.b Uninstall and reinstall.** Uninstall the extension from `chrome://extensions`; confirm with DevTools → Application that the namespaced databases, caches, and the original data are still there; reinstall the same build; confirm the sessions are listed again and B resumes with its data.
  Result: …
- **M-P7.c Extension update during an active session.** With B active, press "Reload" for the extension in `chrome://extensions`; record what the diagnostics say about the reload window (requests that left during it, debugger session re-adopted or lost) and whether the state after the reload is fail-closed or recovered.
  Result: …
- **M-P7.d Install warning and permissions review.** Record the exact permission warnings Chrome shows on install for the final manifest; compare with `manifest.checks.mjs`'s list; anything the person sees that the list does not justify is a defect.
  Result: …

## Corporate environment (when a machine has one)

- Extensions, Developer mode, or the `debugger` permission blocked by policy (`chrome://policy`): record the exact block. Not a defect of the tool; a limit of the architecture that the report must state.
