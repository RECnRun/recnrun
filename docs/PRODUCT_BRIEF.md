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
3. With the extension installed, the website is the only way in: the extension shows its dashboard over the site, at the site's address. `recnrun.com/recordings/<id>` opens that recording, and Back, Forward, and reload work. The dashboard shows its recordings:
   - **Recordings:** grouped by workspace, the one with the newest recording first; each recording, newest first, with its start URL, date (in UTC), duration, and event count.
   - **Empty:** it says there are no recordings yet.
   - **Unreadable** (for example, stored data from an incompatible version): it shows the reason.

   Opened on their own, outside the site, the extension's pages only point to recnrun.com. The toolbar icon has no menu and does nothing; the extension has no keyboard shortcuts or context menu items.

4. The dashboard also lists every open tab. With no recording in progress, every Incognito tab of the open identity offers **Record** (POC branch; see below): a normal tab never does, nor an Incognito tab while no identity is open, and a normal tab can only supply the workspace's address. Record starts the **session**, the recording in progress, one per Chrome profile: the session opens in a floating window (Document Picture-in-Picture) with the state, the elapsed time, Pause or Resume, and Stop, and the recorded tab comes to the front. The site tab that started it **controls** the session. Any number of site tabs can be open; they all show the same session, but only one controls it at a time. While one does, the recorded tab shows the state and elapsed time in every dashboard, and the other tabs offer nothing.

   The floating window also shows the **current tab**, the one in focus, apart from the recorded tab: its icon, title, address, and whether it is incognito or recorded. Switching tabs changes only what it shows; the session keeps recording the tab it started on. When the focus leaves the browser, the window keeps the last tab, marked as not in focus.

   With "Allow in Incognito" on in RECnRun's extension details, the dashboard also lists incognito tabs, marked Incognito, and shows an Incognito workspace panel (POC branch). It keeps one managed Incognito window and **saved identities**, each a name and an address whose Incognito data RECnRun saves on this computer, with nothing to declare in advance: every cookie of the window's Incognito session, whatever site set it, and the local storage, IndexedDB, and Cache Storage of every site the window showed at the top level (and session storage for the site the window shows when it is saved). While an identity is open, every Incognito tab and window is its session: a save keeps each tab's address, its place among the windows, and its own session storage for the site it shows, and a start reopens them as they were, a page that asks to stay included, without any prompt. The user types an **Address** or picks a suggestion from open normal tabs, saved identities, and history (only the address is copied, never cookies or storage); **New identity** saves the open identity, if any, and opens the address empty under the next free name (A to Z, then AA, AB, …). The open identity's row offers **Close**, which saves it and closes its windows; every other row offers **Switch to**, which saves the open identity, closes its windows, and opens the chosen one with its saved data, tabs, and windows, signed in as it was, and **Delete**, which removes it and its saved data after a second click. Each row shows when it was last saved and about how much it holds, and names every site whose storage its last save or start left out: a site that does not answer is skipped rather than failing the command, and the identity keeps what it last saved of that site. A failure shows as an alert naming the command and the step it stopped at. An Incognito window open while no identity is blocks every command but Delete, since no identity owns it, until the user closes it or chooses **Close these windows**; a tab opened while a save runs stops it before anything closes, and the command runs again to save that tab too. While a session exists, every workspace command but Delete refuses with "Stop the recording first"; following a recording across workspaces is a later decision. Reading every site's cookies needs Site access "On all sites": when the user withholds it in RECnRun's details, the panel says so and offers **Open RECnRun's details**, and only Delete stays available. Without "Allow in Incognito", the dashboard lists normal tabs under an "Enable Incognito Mode" banner whose **Open Extension Config** opens RECnRun's details in Chrome, where the toggle is; the banner cannot be dismissed and shows only when Chrome reports the toggle off. Every build, production included, ships the workspace and asks at install for access to all sites and to the browsing history (for the suggestions). RECnRun never stores incognito titles; of incognito addresses it keeps only an identity's address, each tab's address in the identity's saved data so a start reopens it, and, while its window is open, the path of the last page the window showed on each site, without query or fragment. It closes an incognito window only through those explicit commands, or its own window when a start fails or is interrupted. The dashboard opens only from recnrun.com in a normal window; in an incognito window, the site says so. When RECnRun reloads, updates, or turns off, open site tabs ask to be reloaded instead of showing a dashboard that no longer works, and reload themselves when the user returns to them; so after flipping "Allow in Incognito", every site tab follows it without a manual reload.

5. Closing the floating window without Stop keeps the session, gives up the control, and brings the controlling site tab back to the front. So does closing or reloading the controlling site tab. Any dashboard then shows the recorded tab with **Continue**, which reopens the floating window for the same session and takes the control, and **Stop**.

   Only Stop, in a dashboard or the floating window, ends the session; it closes the window and brings the site tab back. Closing tabs never ends it: once the recorded tab closes, every dashboard shows the session as a closed tab, which can only be stopped.

6. Only recording exists today; running a recording again comes later ([Next](#next)).

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
