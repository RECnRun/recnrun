---
name: recording-a-workflow
description: Record what you do in Chrome as a RECnRun workflow when the user asks you to test, retest, reproduce, validate, or demonstrate something in the browser. Also use to re-run a workflow from its recorded steps. Works with Claude in Chrome and any browser tool that can run JavaScript on a page.
---

# Recording a workflow

RECnRun is a Chrome extension that records the steps of a browser tour (clicks, typing, selects, key presses, navigations) as a **workflow** the user can inspect and re-run later. Record every browser test you perform for the user, so the tour is not lost when the conversation ends.

The extension records every tab in **your tab group**. One recording per tab group; other groups (another agent, the human) may record at the same time.

## Constants

```js
const RECNRUN_EXTENSION_ID = "diabhlabffpmdllbkikfpnekcfndipao";
```

Dashboard: `https://recnrun.com/` (production extension) or `http://localhost:5173/` when the user runs the dev extension (`vp run dev` in this repository). The public API is reachable only from a page on one of these origins.

## Flow

1. **Work in your own tab group.** Claude in Chrome groups its tabs already; otherwise group them. Every tab of the test must stay in that group, or its steps are not recorded.
2. **Open the dashboard** in that group and keep it open: it shows the recording live, and it is the page you call the API from.
3. **Start the workflow** by running JavaScript on the dashboard page. Pass `url` so the app under test opens in the same group:

   ```js
   await chrome.runtime.sendMessage(RECNRUN_EXTENSION_ID, {
     kind: "request",
     type: "startWorkflow",
     payload: {
       title: "Log in as admin",
       description: "Happy path through the login form.",
       tags: ["env:local", "feature:login"],
       url: "http://localhost:4200/login",
     },
   });
   ```

   Replies:
   - `{ ok: true, result: { status: "recording", workflow: { id, … } } }`: keep `workflow.id`.
   - `{ ok: true, result: { status: "permission-required", origins: ["http://localhost/*"] } }`: the extension may not record those origins yet. Ask the human to click **Allow access to <origin>** once, in the extension popup or in the dashboard's "Current recording" banner, then send the same request again. Chrome shows that prompt only after a human click; the API cannot grant access.
   - `{ ok: false, error }`: report the error.
   - `chrome.runtime` undefined: the page is not on an allowed origin, or the extension is not installed. Ask the user to install it from the dashboard.

4. **Perform the test** in the group's tabs as usual. Password fields are stored as `***`.
5. **Stop** from the dashboard page:

   ```js
   await chrome.runtime.sendMessage(RECNRUN_EXTENSION_ID, {
     kind: "request",
     type: "stopWorkflow",
     payload: { id: "<workflow.id>" },
   });
   ```

6. **Report** the link `<dashboard>#/workflows/<id>` with the title and tags.

`getRecordingStatus` (no payload) tells whether your group is recording and which origins are still missing. `resumeWorkflow` with `{ id }` adds steps to a stopped workflow instead of starting a new one.

## Re-running a workflow

1. Open `<dashboard>#/workflows/<id>` in your group and read the steps: each is `command selector value` (`navigate`, `click`, `fill`, `clear`, `select`, `press`).
2. Start a new workflow tagged `rerun-of:<id>`, with the original tags.
3. Perform the steps against the live app, in order, and report what differs.
4. Stop and report the new link.

## Tags

`tag`, `tag:subtag`, `tag:subtag:subsubtag`; letters, digits, `_`, `-`. Conventions: `env:local`, `env:ACC`, `env:prod`; `feature:<name>`; `bug:<ticket>`; `rerun-of:<workflow id>`. Keep the user's words for the title; keep tags unique.

## Limits

- Pages on origins the human has not allowed are not recorded until they click Allow. The dashboard and the popup show the button while a tab in the group needs it.
- Clicks on the dashboard itself are not recorded.
- Browser tools that drive the page through DevTools produce trusted events, so the steps show `user` as the author.
