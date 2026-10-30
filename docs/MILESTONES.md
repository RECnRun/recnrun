# Milestones

## M0: Bootstrap, detection, and read-only explorer (done, superseded)

The monorepo, its quality gates, and the first vertical slice: the website detected the extension and listed seeded recording summaries. M1 replaced the recordings explorer with workflows; the detection, origin-guard, CSP, and manifest checks stayed.

## M1: Explicit workflow recording per tab group

The extension records workflows started by an agent through its public API or by a human from the popup; the website shows them live.

Acceptance (all automated, run by `vp run verify`):

- [x] Without the extension, the website shows the install banner with a link to the install guide (`tests/e2e/install-banner.spec.ts`).
- [x] With the extension and no data, the website shows an empty state instead of the banner (`tests/e2e/workflows.spec.ts`).
- [x] A page on recnrun.com starts a workflow with `chrome.runtime.sendMessage(RECNRUN_EXTENSION_ID, …)`, the app URL opens in the caller's tab group named "RECnRun", and the dashboard shows the recording and its `navigate`, `click`, `fill`, masked password, and `press Enter` steps as they happen (`tests/e2e/workflows.spec.ts`).
- [x] A tab outside the recording group records nothing; after `stopWorkflow` nothing is recorded, and `resumeWorkflow` records again (`tests/e2e/workflows.spec.ts`).
- [x] The list filters by tag (`tests/e2e/workflows.spec.ts`).
- [x] The public API exposes control requests only: `listWorkflows` gets no answer, and a page on another origin has no `chrome.runtime` (`tests/e2e/workflows.spec.ts`).
- [x] The popup starts a workflow from its form for the active tab's group and stops it (`tests/e2e/workflows.spec.ts`).
- [x] A page on another origin cannot get an answer from the extension by posting bridge messages to the website's window (`tests/e2e/origin-guard.spec.ts`).
- [x] The production build ships a CSP and loads without violations (`tests/e2e/install-banner.spec.ts`).
- [x] The production manifest runs the content script and the public API only on `https://recnrun.com/*`, asks for `storage`, `scripting`, `tabs`, and `tabGroups`, lists every site only as an optional host permission, and fixes the id through `key` (`vp run test:extension-manifest`).
- [x] Every gate in [AGENTS.md](../AGENTS.md#rules) runs in `vp run verify`, locally and in CI.

Manual, once per release of the extension:

- [ ] Load `apps/extension/.output/chrome-mv3` unpacked in Chrome, start a workflow from the popup on a public site, accept Chrome's prompt after **Allow access**, and see the steps on recnrun.com.
- [ ] Ask Claude Code to test a local app with the `recording-a-workflow` skill and open the reported link.

## Next

- M2: re-run a workflow's steps against the live application, from the start or from a chosen step ([PRODUCT_BRIEF.md](PRODUCT_BRIEF.md#next)).
- M3: reorder, edit, export, and merge steps.
- Publish the extension to the Chrome Web Store, and point the install banner at the listing.
