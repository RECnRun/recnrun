- Linux shows no prompt. `autostart on` writes a `systemd --user` unit (see `autostart status`); where
  `systemctl --user` is missing it exits 70 and prints the command that runs the launcher in the
  background instead.
- Chrome may show the "Disable developer mode extensions" notice each time it starts (see above).
