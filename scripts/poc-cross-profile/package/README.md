# RECnRun launcher (proof of concept)

This folder holds the launcher and the prepared extension for {{OS}}. Nothing is built or installed:
the launcher is POSIX `sh` scripts, the extension is a folder Chrome loads as it is. It needs
Google Chrome and no other program.

## Check the folder

Put the folder where its path has only letters, digits, dot, underscore, hyphen, and slash (for
example `~/recnrun-launcher`; the autostart writer refuses a path with a space), then run, inside it:

```
{{VERIFY}}
```

Every line must end in `OK`.

## Prepare each profile (once per profile)

Four gestures, in each Chrome profile that should run flows:

1. Open `chrome://extensions` in the address bar.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Choose the `extension` folder of this package.

Chrome may show a "Disable developer mode extensions" notice when it starts. Do not click Disable
(that turns the extension off); close the notice or ignore it.

## First command

From this folder, once per machine, after the profiles are prepared and Chrome has run for a few
seconds:

```
sh recnrun-launcher first-run
```

It registers the Default profile of Chrome's own folder, opens it, waits for the extension's own
acknowledgement, and prints `<profile id> open` per profile, then the autostart command to run
next. The launcher never reads Chrome's own folder (macOS may ask for Full Disk Access for it): the Default is known by convention and bound by that
acknowledgement. Chrome starts on it with a one-time token and the profile id comes from the
extension's answer, so nothing is written when the extension does not answer; the message then tells you to load the extension in the Default and run `install` again. Its Downloads folder is `~/Downloads`; if Chrome downloads elsewhere, run `install --downloads <folder>` (also `first-run --downloads <folder>`; plain characters only). Other personal profiles of Chrome's own folder are not supported. The Default profile of Chrome's own folder becomes the master in the same run, with no extra step: its extension is asked once through the same one-time token, and the launcher record gets `role=master` only after the extension answers. Run it again after you fix a missing extension or Downloads folder; a profile that is already registered is not
opened twice. Each pass of the launcher, `first-run` included, also writes the catalog `registry.json` into the `RECnRun/poc/lab` folder of each profile's Downloads folder: the extension cannot list folders, so it finds the other profiles only through that file. The launcher keeps its state in `$HOME/.recnrun/launcher` and its record in
`$HOME/.recnrun/launcher.record`, both under the namespace `lab`. Exit 0: every profile is open;
66: no Chrome folder and nothing registered; 70: a profile did not open or did not acknowledge.

To do both steps with one command, run `install` instead of `first-run` and `autostart on`:

```
sh recnrun-launcher install
```

It runs `first-run` and, only when every profile is open and the Default is the master, turns
autostart on with the same state directory, record, and namespace; it prints `autostart on` as its last line.
Exit 0: every profile is open and autostart is on; 64: wrong arguments; 65: a refused path; 66: no
Chrome folder and nothing registered; 70: a profile did not open or acknowledge, the Default did not become the
master, or `autostart on` failed (the profiles stay open; run `install` again).

Count: 4 N + 3 for N profiles, 7 for one: the 4 Load unpacked gestures per profile and the 3
commands this README has you run (`first-run`, `status` to verify, `autostart on`). The 4 N gestures
are estimated, not observed: the host twin installs the extension over CDP, so M-P4.b measures
them. The commands are observed by the host twin: `first-run` and `status`; `autostart on` is
checked against stubbed `launchctl` and `systemctl` only, so M-P4.a covers its real login.

## What the OS asks

{{PROMPTS}}

## Every day

Once:

```
sh recnrun-launcher autostart on "$HOME/.recnrun/launcher" "$HOME/.recnrun/launcher.record" lab
```

After that the launcher starts at login and keeps the registered profiles open; nothing else to
type. Other commands:

```
sh recnrun-launcher status "$HOME/.recnrun/launcher"
sh recnrun-launcher stop "$HOME/.recnrun/launcher" --all
sh recnrun-launcher autostart off "$HOME/.recnrun/launcher" "$HOME/.recnrun/launcher.record" lab
```

`status` lists the launcher and each profile; `stop` ends the launcher and `--all` also closes the
profiles it opened; `autostart off` removes the login entry.

## What the launcher never does

It opens no network connection, runs nothing with `sudo`, and never edits a profile's
`Preferences`. It opens only profiles it registered, and writes only under `$HOME/.recnrun` and the
autostart entry.
