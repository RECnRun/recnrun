# Zephyr manual run (POC task S4.4)

This runbook checks the Incognito identities POC against Zephyr with real test accounts. Only the user runs it: agents never open Zephyr or any `one.be` host, and they never see the accounts. Until the user has run it, the POC report says Zephyr is **not validated**.

## Rules for the run

- Use only test accounts you are authorized to use. This document calls them A, B, and C. Never write down their names or emails.
- Write down names, counts, sizes, timings, and yes/no outcomes. Never write down values: no cookie values, tokens, storage contents, response bodies, or screenshots that show any of them.
- Captures stay in the run's own Chromium profile, under `.artifacts/poc-zephyr/`. That folder is never committed. The script deletes it when the run ends, so do not copy anything out of it.

## Start

1. Run `vp install`, then `vp run poc:zephyr` from the repository root.
2. The script does the following:
   - Builds the extension in development mode with host access to `https://zephyr-tq.one.be` and `https://login-acc.one.be`, plus `one.be` itself, since cookies set for `.one.be` need it. It prints the host patterns and builds into `apps/extension/.output/chrome-mv3-dev`, so a running `vp run dev:extension` gets rebuilt.
   - Starts the website at `http://localhost:5173/`, unless one is already running there.
   - Opens headed Chromium on a new, empty profile with Developer mode on, showing RECnRun's details page and the site.
3. On the details page, turn on **Allow in Incognito**. The site tab then shows the dashboard with the **Incognito workspace** panel.
4. If Zephyr's sign-in goes through another host, add its origin and run again, for example `RECNRUN_POC_HOSTS=https://zephyr-tq.one.be,https://login-acc.one.be,https://other.one.be vp run poc:zephyr`.

## 1. The normal profile's own sign-in

In a normal tab of that Chromium, sign in to Zephyr with an account other than A, B, and C, which this document calls N. At the end of the run, reload that tab and record whether it still shows N. RECnRun must never change a normal window's session.

## 2. Native Incognito baseline (nothing restored)

1. In the dashboard, type `https://zephyr-tq.one.be/` into **Address** and click **Start**. This opens one managed Incognito window and restores nothing.
2. Sign in as A in that window. Record:
   - whether the app shows A;
   - in DevTools > Application > Service workers, whether a worker is activated and controls the page after one reload;
   - in DevTools > Network, the number of authenticated API calls and their status classes (for example `12 × 2xx, 0 × 401`);
   - with DevTools > Network set to **Offline**, whether a reload shows the app shell. Set it back to online afterwards.
3. Close the window with **Close and start empty**, or close it by hand.

This baseline separates Zephyr's own Incognito behavior from anything RECnRun changes.

## 3. Identities A → B → A → C → A

Give every identity the same **Address**, `https://zephyr-tq.one.be/`, and the same **Cookie hosts**, `login-acc.one.be`. Add any other sign-in host from step 4 of Start, separated by commas. The dashboard refuses a host this build cannot read, and names it.

| Step | Action in the dashboard                          | Then                        |
| ---- | ------------------------------------------------ | --------------------------- |
| 1    | Label `A`, then **New identity**                 | Sign in as A                |
| 2    | Label `B`, then **New identity** (saves A first) | Sign in as B                |
| 3    | **Switch to** on row A                           | Check A, without signing in |
| 4    | Label `C`, then **New identity** (saves A first) | Sign in as C                |
| 5    | **Switch to** on row A                           | Check A, without signing in |

After steps 3 and 5, record:

- whether the app shows A without a sign-in prompt;
- whether the first load showed B's or C's account at any moment (it must not);
- whether a worker controls the page after one reload (the first load registers it again, since registrations are not restored);
- the number of authenticated API calls and their status classes;
- whether the window's title bar or the address bar showed an error page;
- the time from the click to the app showing A, measured with a stopwatch, in seconds;
- the size the dashboard shows on each row, for example `about 1.2 MB`.

Also record, once and without values, anything the app stores outside the address's origin. Open DevTools > Application on a page of `login-acc.one.be` and note whether localStorage or IndexedDB hold entries there; record their key names only. RECnRun keeps only the cookies of a declared host, never its storage.

## 4. Suspend and Resume

1. Click **Suspend** on row A, then **Resume** on row A, and record the same checks as above.
2. Optional: set the computer offline before **Resume**. It is expected to fail at the `navigate` step, since no registration survives the window, and to leave no window open. Record the failure text the panel shows.

## If something fails

The panel shows an alert that names the command and the step where it stopped. Record that text as shown. Record the outcome of retrying the same command once.

## End

1. Click **Delete** on rows A, B, and C, then **Delete <label>** to confirm each one.
2. Reload the normal tab and record whether it still shows N (see section 1).
3. Close Chromium. The script prints `Deleted the run's profile, its captures, and the build.` Confirm that `.artifacts/poc-zephyr` no longer exists.
4. Give the recorded names, counts, sizes, timings, and outcomes to the orchestrator for the report (task S4.5).

## Known limits to expect

These are platform limits recorded in the [POC checklist](poc-incognito-sessions-checklist.md), not failures of the run:

- A resumed identity has no service worker registration until its first load registers one again, so that load needs the network.
- A declared cookie host contributes its cookies only, never its localStorage, IndexedDB, or caches.
- RECnRun saves only its own tab. Another Incognito window or tab blocks every command but Delete until you close it.
