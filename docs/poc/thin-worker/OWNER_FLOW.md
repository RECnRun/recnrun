# Owner flow on macOS: the owner script

LAB-ONLY. The owner page in the person's own Chrome (the master) launches one headless worker Chrome on a private root through the lab launcher, a foreground POSIX sh script, and then drives the worker's page over WebRTC. The launcher only bridges the first offer and answer, and relaunches after an irreparable loss of the link; URL, viewport, input, lease, and frames go over WebRTC. The Linux Docker journey is `w-owner-flow.spec.ts` ([RESULTS.md](RESULTS.md#owner-flow)); this script is its macOS run by the owner.

## Before you start

- Nothing is installed into the personal Chrome. The worker runs on its own root under `~/RECnRun-lab/roots/w1`, with its own `--user-data-dir`, headless, and with no `--remote-debugging-*` flag.
- `~/RECnRun-lab` sits outside Documents, Desktop, and Downloads, so neither Chrome's folder picker nor the macOS privacy prompts for those folders get in the way of the launcher in Terminal.
- The launcher uses `/usr/bin/openssl` on macOS (LibreSSL). It prints the version in its first log line; any version is accepted, record the one you see.
- `--allow-any` lets the worker open any `http:` or `https:` origin. A host worker has no egress firewall (the Docker tests do); that is accepted for this lab.
- Run everything from the worktree: `cd /Users/dannyelcf/src/recnrun/.claude/worktrees/poc-downloads-launcher`.

## Script

1. **Terminal A:** `vp run lab:owner`. It serves the owner page on `http://127.0.0.1:47811/` and the lab target on `http://127.0.0.1:47812/interact`.
2. **Chrome (Default profile):** open `http://127.0.0.1:47811/`.
   - Expect the banner "Choose the RECnRun folder".
   - Click **Choose folder**, create and select `~/RECnRun-lab/workspace`, and allow editing.
   - Expect the banner "Start the launcher" and the command below it.
3. **Terminal B:** `sh tests/lab/web-master/launcher/launcher.sh start ~/RECnRun-lab --allow-any`.
   - Expect a first line `launcher: lab .../RECnRun-lab, session ..., launcher 0.1.0, extension 0.0.1, LibreSSL ...`.
   - Chrome shows "Confirm in the launcher terminal" with the master fingerprint; the terminal asks `Site shows master xxxx xxxx xxxx xxxx xxxx? [y/N]`. Compare both and type `y`.
   - Expect `paired=<64 hex>` in the terminal and the banner "Ready" in Chrome.
4. **Launch:** set the URL field to `http://127.0.0.1:47812/interact`, click **Launch**.
   - The first launch provisions the worker root (the Docker run takes about 9 s; allow up to 2 min): the terminal prints `provisioned generation 1, worker xxxx ...` and `worker pid N on .../roots/w1/chrome`.
   - Expect "launched: interact on the image below" and the page in the panel. Click the fixture's button: its counter increments.
5. **Worker flags:** `ps -ww -eo pid=,args= | grep RECnRun-lab/roots/ | grep -v grep`. Expect `--headless=new` and no `--remote-debugging` or `--enable-unsafe-extension-debugging`.
6. **Viewport match:** resize the owner page's Chrome window, larger then smaller. The panel fills the window, and within a second the picture fills the panel with no letterbox and stays sharp; clicks still land where you aim. The worker clamps its viewport to 320×240 through 1920×1080.
7. **Internet target:** set the URL to `https://example.com/` and click **Launch**. Expect the page in the panel and its link clickable.
8. **Reload:** reload the owner page, then click **Reconnect**. Expect "launched" again within about 15 s and no new `provisioned` line in the terminal.
9. **Stop:** Ctrl-C in Terminal B.
   - Expect exit status 130 (`echo $?`) and, within 20 s, the banner "Start the launcher".
   - `pgrep -fl RECnRun-lab/roots` prints nothing.
10. **Restart:** run the step 3 command again. Expect no pairing prompt, the banner "Ready", and **Reconnect** working with no new `provisioned` line.
11. **Cleanup:** Ctrl-C in Terminals B and A. Optionally `rm -rf ~/RECnRun-lab` and clear the site data of `127.0.0.1:47811` (master key and worker pin).

Record the Chrome version, the macOS version, the openssl line, pass or fail per step, and a screenshot of each banner.

## Recovery

- "The launcher is paired with a different key": stop the launcher, run `rm state/master.spki state/master.pem state/paired` in `~/RECnRun-lab` (the terminal prints the same command), start it again, and confirm the new fingerprint.
- "Renew folder access": click **Renew access** and allow editing again.
