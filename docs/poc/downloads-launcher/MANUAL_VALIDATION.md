# Manual validation

Everything in [PLAN.md](PLAN.md) that needs a person. The owner authorized Claude to drive the installed Google Chrome on this Mac, including the personal Default profile (PLAN.md decision 3), so most host cells are automated host runs recorded in [CHECKLIST.md](CHECKLIST.md). What remains here is what no runner can do: the `Load unpacked` gesture in the personal Default (Chrome 137 removed `--load-extension` from branded builds and `chrome://extensions` is not scriptable), an OS login, a machine sleep, a Windows machine, and a Web Store publication. Record the date, machine, OS, Chrome version, build hash, and result under each item; a failed item opens a regression spec before anything else.

## After P1

- **M-P1.a Install in the personal Default and toggle file access.** With the `poc-d0` build: `chrome://extensions`, Developer mode, `Load unpacked`; record the permission texts on the card, the extension id (must equal the pinned id), `isAllowedFileSchemeAccess()` from the diagnostics page before and after "Allow access to file URLs", and the number of gestures. This is the manual install the source allows in every variant (§1.1); the toggle is a gesture that fails V1's "install only" criterion and is counted as such (§1).
  Result: …

## After P4

- **M-P4.a Autostart after an OS login.** `recnrun-launcher autostart on`, log out and back in (or restart), confirm the LaunchAgent started the launcher without a command and that `status` reports it; then `autostart off` and confirm it did not start on the next login.
  Result: …

## After P5

- **M-P5.a Install in the base by hand (V2).** `Load unpacked` of the same build into the base root opened by `create-base`; record the gestures. V3 (P6.2) replaces this step by the automatic installation; both results are kept.
  Result: …

## After P9

- **M-P9.a Sleep and wake.** With the Default and two workers linked, close the lid (or `pmset sleepnow`) for two minutes, wake, and record from the diagnostics files the link repair time and that no opening loop occurred.
  Result: …
- **M-P9.b Windows.** Not executed in this round: no machine. The report says "not executed".
- **M-P9.c Packed distribution.** Not executed in this round: no Web Store test channel available (owner, 2026-11-03). The zip from P1.1 is kept for a later publication; the report says "not executed".
