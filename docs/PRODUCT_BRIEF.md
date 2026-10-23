# Product brief

RECnRun records a browser session once and replays it whenever the developer needs it: logging in, filling a long form, reproducing a bug. The browser extension owns the user's data. The website at [recnrun.com](https://recnrun.com) detects the extension; when it is installed, the extension shows its own dashboard there.

## Concepts

| Concept       | Meaning                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Recording** | One captured browser session: a name, the URL where it started, when it was made, how long it lasted, and how many events it holds.    |
| **Workspace** | The site a recording starts on (its origin, such as `https://shop.example`). The dashboard groups recordings by workspace.             |
| **Snapshot**  | Everything the extension stores, as one versioned document. Today it holds the list of recordings; recording ids are unique within it. |

The events themselves (clicks, inputs, navigations, DOM changes) are not stored yet; M0 keeps only each recording's summary. See [Next](#next).

## The website and the extension

1. A visitor opens recnrun.com (or a local dev server).
2. The website asks whether the extension is installed. If it is missing, the website shows a banner explaining what the extension does, with a link to the install guide.
3. The extension's dashboard (`dashboard.html`) shows its recordings:
   - **Recordings:** grouped by workspace, the one with the newest recording first; each recording, newest first, with its start URL, date (in UTC), duration, and event count.
   - **Empty:** it says there are no recordings yet.
   - **Unreadable** (for example, stored data from an incompatible version): it shows the reason.
4. The dashboard also lists every open tab. With no recording in progress, each tab offers **Record**, which opens the session beside it, and **Float**, which opens the session in a floating window over it. The recorded tab shows the state and elapsed time with Show, Pause or Resume, and Stop; the other tabs wait until it ends. Any number of dashboards can be open, in tabs or over recnrun.com, and a dashboard tab can be the recorded tab itself.

   Each recording has its own link, `dashboard.html#/recordings/<id>`.

5. The **session** is the recording in progress, one per Chrome profile. Its page (`session.html`) shows the state, the elapsed time, Pause or Resume, Stop, and a link that opens a new dashboard tab. It lives in one of two places:
   - **Beside the recorded tab,** in a Split View (Chrome 155+), or in the next tab without Split View. Float moves the controls into a floating window and lets the page fill the window; closing that window without Stop brings the session back beside the page.
   - **In a floating window** (Document Picture-in-Picture) that a dashboard opened.

   The toolbar icon, the page's "Open RECnRun" context menu item, and Alt+Shift+S (MacCtrl+Shift+S on macOS) start recording the current tab, with the session beside it. On another tab while a session runs, they move the session beside that tab, which it then records; while the session floats, they do nothing. Alt+Shift+D (MacCtrl+Shift+D) and the icon's "Dashboard" context menu item open a new dashboard tab.

   Stop ends the session and closes its pane and its window; closing the recorded tab ends it too. Typing the session page's address shows that no recording runs.

6. On recnrun.com, the extension shows the same dashboard over the site, at the site's address: `recnrun.com/recordings/<id>` opens that recording, and Back, Forward, and reload work. Float there has the site open the floating window, since a frame cannot.

7. The website's footer links to the privacy policy at `recnrun.com/privacy/`. The extension leaves that page alone, so it stays readable with the extension installed.

The website never sees the user's data: only the extension reads it, in the visitor's own browser, and the site cannot read the dashboard's frame.

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
