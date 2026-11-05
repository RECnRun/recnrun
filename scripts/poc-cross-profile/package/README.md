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

It registers each profile that has the extension, opens it, waits for the extension's own
acknowledgement, and prints `<profile id> open` per profile, then the autostart command to run
next. Run it again after you prepare another profile; a profile that is already registered is not
opened twice. The launcher keeps its state in `$HOME/.recnrun/launcher` and its record in
`$HOME/.recnrun/launcher.record`, both under the namespace `lab`. Exit 0: every profile is open;
66: no profile with the extension and a presence of its own yet; 70: a profile did not open.

Gesture count: 4 per profile plus the one command, so 5 for one profile and 4 × N + 1 for N.

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
