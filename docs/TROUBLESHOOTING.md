# Troubleshooting

Problems we hit, what caused them, and how we solved them. Add an entry when a problem took real investigation, so nobody has to repeat it.

## Chrome's folder picker never shows in an end-to-end test (solved)

**Symptom.** `showDirectoryPicker()` in a Playwright test rejects at once with `AbortError: Failed to execute 'showDirectoryPicker' on 'Window': Intercepted by Page.setInterceptFileChooserDialog().`, and no `filechooser` event fires, so the folder flow looked impossible to test without a mock.

**Cause.** Playwright enables `Page.setInterceptFileChooserDialog` on every page so that `page.on("filechooser")` can answer `<input type="file">`. Chrome treats the File System Access picker as a file chooser too, but Playwright has no handler for a directory picker, so the request is cancelled.

**Solution.** `tests/e2e/fixtures/native-dialogs.ts` turns the interception off per page through a CDP session and drives the dialogs on the container's Xvfb display with `xdotool` (installed with `scrot` by `Dockerfile.tests`). Found on the way: Chrome opens the picker only for the active tab, so the driver brings the page to the front once, before the click that opens it, and never again, since `page.bringToFront()` with no window manager raises the browser window over a prompt Chrome already shows; the picker is a GTK window found by its title, where `ctrl+l`, the path, and `alt+o` choose the folder while `Return` cancels; "Allow this site to edit files?" comes up with Don't Allow focused, so `Tab` and `space` allow and `Return` denies; the three-button prompt after a restart takes no keyboard focus at all, so the driver clicks at a fixed offset from the browser window's corner, one for a normal window and one for the folder popup, which has no toolbar, so the prompt hangs higher; raising the browser window with `windowraise` covers a prompt Chrome already shows, so the driver never raises it; a button under the pointer, where the last answer left it, is no longer light blue, so the driver first moves the pointer to the display's corner (without `--sync`, which waits forever when the pointer is there already); within one browser session, once a grant has ended with the extension's last top-level page, Chrome asks again with either prompt, not always the same one, so `allowInEitherPrompt` answers whichever shows and says which; the driver has no handle on either bubble, so it waits for what each does to the display, read with `scrot -a` one pixel at a time (`fixtures/display.ts`): the write prompt dims the page, and the restore prompt's buttons are light blue; and there is no window manager, so windows stack at the origin and each gets focus explicitly. A failed test keeps a screenshot of the display (`display.png`) and a listing of the folder (`folder.txt`) in its output folder.

## Chrome shows its write prompt instead of "Allow on every visit" (solved)

**Symptom.** With the profiles' folder windows closed, "Allow folder" in a new folder window showed Chrome's two-button write prompt, again and again within one session, and only sometimes, after a varying number of tries or seconds, the three-button restore prompt that offers "Allow on every visit". The dashboard's folder banner also stayed hidden until the site reloaded.

**Cause.** Read in Chromium's `chrome/browser/file_system_access/chrome_file_system_access_permission_context.cc`. `IsEligibleToUpgradePermissionRequestToRestorePrompt` offers the restore prompt only for a grant created from a handle loaded from storage (`AccessTrigger::kLoadFromStorage`). `GetWritePermissionGrant` reuses the grant for a path while any handle references it, keeping the trigger it was created with. The offscreen document loads the stored handle while the folder window is open, so its handles kept the picker's grant (`kOpen`) alive until V8 collected them. Separately, the grant ends as the last extension page closes (`OneTimePermissionsTracker` notifies `OnLastPageFromOriginClosed` with no delay), and nothing told the dashboard.

**Solution.** Before "Allow folder", the folder window sends `folder-release`, and the background closes the offscreen document while the link is down, with all of its handles; the window's own handle, loaded from IndexedDB, then gets the restore prompt every time. The background tells the pages to read the status again whenever a tab closes. `folder-pairing.spec.ts` "a folder window closed before pairing…" got the write prompt 3 times out of 3 without the release, and the restore prompt 5 times out of 5 with it.

## xdotool reports a window closed while it is still open (solved)

**Symptom.** In the container, a native-dialog test failed now and then while it searched for Chrome's folder picker or the browser window, with `xdotool search` exiting on `BadWindow`; and a wait for the picker to close could pass while the picker was still on screen.

**Cause.** `Dockerfile.tests` installs Ubuntu noble's xdotool 3.20160805, which predates [the fix for a race in `search`](https://github.com/jordansissel/xdotool/pull/335): when any window closes while `search` walks the window tree, it exits 1 on `BadWindow` instead of skipping that window. No match also exits 1, so a closing tooltip or bubble looked like the picker being gone. A probe that searched while windows opened and closed said "gone" 5 times in 300.

**Solution.** `search()` in `tests/e2e/fixtures/native-dialogs.ts` tells the two apart by stderr: `BadWindow` means search again, exit 1 with empty stderr means no match, and anything else is an error. The same probe then said "gone" 0 times in 300.

## A push dies during the pre-push hook (solved)

**Symptom.** `git push` over SSH ran the pre-push hook (`vp run verify`, about eight minutes) to the end and then exited 141, with "Connection to ssh.github.com closed by remote host." or, with `ServerAliveInterval` set, "Read from remote host ssh.github.com: Can't assign requested address".

**Cause.** Git opens the SSH connection and reads the remote's refs before it runs the hook, and the connection stays idle while the hook runs; it does not survive eight minutes, and Git dies of `SIGPIPE` writing to it. A throwaway clone with a pre-push hook that only sleeps 480 seconds reproduced it.

**Solution.** Push over HTTPS, which opens a new connection after the hook; the hooks still run. With the GitHub CLI signed in:

```sh
git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push https://github.com/RECnRun/recnrun.git <branch>:<branch>
```

## A peer's Disconnect shows as "Disconnected" instead of "Disconnected by <name>" (solved)

**Symptom.** `cross-profile-link.spec.ts` "a profile that disconnects tells the other…" failed now and then: B's dashboard read "Disconnected — Profile A".

**Cause.** A's Disconnect sends `BYE` and closes the channel, so B's offscreen document reports the frame and then the close, back to back. The background handled each link event as it arrived, without waiting for the previous one; when the close was written first, the link was no longer verified, and `peer-channel.ts` dropped the `BYE` as coming from an unauthorized peer.

**Solution.** `createLinkHandler` in `background/peers.ts` runs link events one after the other, in arrival order. `peers-link.test.ts` "a BYE keeps its reason when the channel's close arrives right behind it" delays the first storage read to reproduce the race.

## Profiles stay "Connecting" for about 35 s before they reconnect (solved)

**Symptom.** After **Reconnect**, or after a restart, both dashboards said "Waiting for <name> in the RECnRun folder…" for about 35 s, though both presences were fresh in `pairing/`.

**Cause.** `background/folder-pairing.ts` waited `RETRY_MS` (30 s) after each answer or connect before acting again, on both sides, to give the link time to come up. Two cases hit it with nothing in flight: the offerer's last offer stays in the folder until it expires, so the answerer, starting to wait again, answered that stale offer and then ignored the offerer's new one for 30 s; and the offerer counted its 30 s from the connect of the link that had just dropped.

**Solution.** The answerer answers each new offer at once, since a new offer means the offerer gave up the last; it still answers a pairing id only once. Once a link comes up, `linked()` sets the attempt's time to zero, so a later drop needs no wait. The 30 s now holds only while an offerer's attempt has not come up. `folder-pairing.spec.ts` "profiles that both allowed the folder on every visit…" disconnects, reconnects, and expects the link within 10 s.
