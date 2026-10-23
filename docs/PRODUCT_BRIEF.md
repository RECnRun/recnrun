# Product brief

RECnRun records a browser session once and replays it whenever the developer needs it: logging in, filling a long form, reproducing a bug. The browser extension owns the user's data. The website at [recnrun.com](https://recnrun.com) detects the extension and shows that data.

## Concepts

| Concept       | Meaning                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Recording** | One captured browser session: a name, the URL where it started, when it was made, how long it lasted, and how many events it holds.    |
| **Snapshot**  | Everything the extension stores, as one versioned document. Today it holds the list of recordings; recording ids are unique within it. |

The events themselves (clicks, inputs, navigations, DOM changes) are not stored yet; M0 keeps only each recording's summary. See [Next](#next).

## The website and the extension

1. A visitor opens recnrun.com (or a local dev server).
2. The website asks whether the extension is installed.
   - **Missing:** it shows a banner explaining what the extension does, with a link to the install guide.
   - **Installed:** it reads the extension's data and shows each recording, newest first, with its start URL, date (in UTC), duration, and event count.
   - **Installed but empty:** it says there are no recordings yet, rather than asking to install.
   - **Installed but unreadable** (for example, stored data from an incompatible version): it shows the reason.
3. The extension dashboard (`dashboard.html`, opened in a tab from the toolbar icon, its context menu, Alt+Shift+D, or the `rr` address-bar keyword) lists the stored recordings. `rr <text>` suggests recordings by name and deep-links the dashboard to the chosen one (`dashboard.html#/recordings/<id>`).

The website never stores the user's data and never sends it anywhere: it reads it from the extension in the visitor's own browser.

## Next

Product direction, not commitments; each step gets its own milestone in [MILESTONES.md](MILESTONES.md).

- **Capture.** Record a lossless timeline of the session in the current tab (user input, navigation, and DOM changes, including those driven by timers and async code), stored by the extension. rrweb is the leading candidate for the capture layer.
- **Replay.** Play a recording back as the user saw it.
- **Steps.** Turn a recording into re-runnable steps with stable locators (click, type, navigate, assert), and run them against the live page.
- Recording happens in the user's own applications, in tabs the website cannot see, so it needs its own extension surface (for example, a side panel) and per-origin permissions granted at run time; see the [security model](ARCHITECTURE.md#security-model).

## Out of scope for now

Recording, replaying, and editing. The current milestone is read-only; see [MILESTONES.md](MILESTONES.md).

## Platforms

Chromium-based browsers with Manifest V3 (Chrome, Edge, Brave). Firefox and Safari are not planned yet.
