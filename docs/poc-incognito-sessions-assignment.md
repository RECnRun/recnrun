# Origin Snapshot Manager POC — Sequential Incognito Sessions

This is the assignment as given on 2026-10-28, kept verbatim so every stage can be checked against it. The plan is [poc-incognito-sessions-plan.md](poc-incognito-sessions-plan.md); progress is tracked in [poc-incognito-sessions-checklist.md](poc-incognito-sessions-checklist.md).

Additional instruction from the user: open pull requests may contain relevant discussions, experiments, or design decisions. Consult them for context, but do not cherry-pick their commits or code into this POC. Implement the POC independently from the remote `master` baseline.

## Assignment

Plan and implement this POC in an isolated worktree based on the current remote `master`. The planning review inspected RECnRun commit `44c154da29860c7a8df829e902b177df5ce2ba2a` on October 28, 2026. Resolve the remote head again before implementation and record the actual base commit. Follow `AGENTS.md`, scoped rules, red/green testing, and the full verification gate.

The dashboard stays in a normal Chrome window. Recording and execution always target a managed Incognito workspace. Exactly one identity is active at a time. Switching identities saves the current identity, closes the entire managed Incognito workspace, and creates a new Incognito session before restoring the destination.

This assignment concerns workspace and snapshot lifecycle. The existing recording controls do not establish that event capture or execution engines already exist. Do not implement a complete recorder or runner as an incidental part of this POC.

## Product rules

- Keep the existing normal-window dashboard and its Document PiP controls. Neither may become dependent on an Incognito opener that switching will destroy.
- Require Chrome's existing “Allow in Incognito” setting. Never attempt to enable it programmatically.
- Before starting, enumerate Incognito windows visible to this extension in this profile. Existing windows block startup. Offer a dashboard action explicitly labeled to close those windows and start; otherwise allow the user to close them manually.
- Do not silently adopt or close unrelated windows. The explicit close action covers the windows presented to the user. Newly appearing windows require a refreshed decision.
- Initially support one managed window and one application tab. Same-window authentication popups or additional tabs require an explicit extension of that scope and tests.
- During a session, unexpected Incognito windows or tabs cause a visible conflict and prevent switching until resolved. Observing browser events does not prevent users or other extensions from opening windows: document that limit.
- Recheck the window inventory before capture, before closing, and before creating the replacement. Never create the replacement while an old Incognito window remains open.
- Recording a normal tab is no longer allowed. A normal tab may supply a destination URL, but its cookies and storage are not copied automatically.
- Reject browser-internal URLs as recording or execution targets. They can be temporary workspace pages only.
- Separate `Pause` (recording controls), `Suspend` (save application storage and close the workspace), and `Resume` (create a workspace, restore storage, reload the app). These operations have different meanings.
- Treat snapshots as stored local application data, not a frozen browser process. JavaScript memory, pending requests, sockets, DOM state, and the exact running Service Worker are not resumed.
- Retain snapshots locally in the normal extension context across Incognito teardown. Make this persistence explicit in the dashboard and provide deletion of saved sessions.

## Primary architecture decision

Use native browser storage within the disposable Incognito context. Do not virtualize cookies, IndexedDB, Cache Storage, or worker APIs per tab. Leave application Service Workers enabled during normal operation.

Retain `incognito: "spanning"` unless an experiment demonstrates a concrete reason to change it. The existing normal extension service worker is the coordinator and the extension's normal IndexedDB is the snapshot repository. Never assume the repository must disappear with Incognito browsing data.

Use page-origin code only to operate that page's native storage and relay validated results. Keep extension repository access in its existing storage boundary; adding site-storage access requires explicitly documenting the new responsibility. Keep snapshot contents out of the website bridge. Commands originate in trusted extension UI and are validated by sender, tab, document, expected origin, operation ID, and workspace generation.

Allow only one lifecycle operation at a time. Persist minimal operation metadata so extension service-worker suspension cannot silently turn an unfinished operation into success. Late responses from old documents or workspace generations must not mutate the new session.

No companion app, local service, remote backend, `chrome.debugger`, CDP in the product, extensive native API patching, incremental backup, or unrelated refactoring. Playwright may automate the browser but must not implement the reset or restore that the extension is meant to perform.

## What the SplitSession review established

The reviewed SplitSession source tree is `475afe88cd1ec7208b2a5510759036955032e0d4`.

- Its container design uses tab-scoped network rules and page API namespaces, rather than native independent Chrome profiles.
- `src/content/shim/patches/indexed-db.ts` changes database names and filters enumeration; it is not a database backup/restore adapter.
- `src/content/shim/patches/workers.ts` rejects Service Worker registration and hides SharedWorker in container tabs. `src/content/shim/install.ts` includes the Service Worker patch in managed/container modes regardless of Strict Mode.
- Strict Mode broadens the policy to the whole profile. Turning it off does not make container tabs support native PWA workers.

Reuse its adversarial test ideas, navigation ordering lessons, and cookie-attribute cases where useful. Do not transplant its container engine or worker policy. Copy code only when it reduces the POC's scope and preserve the applicable MIT notice.

Keeping one active user makes native storage plausible, but leaving a shared native Service Worker alongside virtualized per-user databases/cookies would still be inconsistent. Do not combine those models without a separate demonstration.

## Stage 1 — Prove native context reset

Build the smallest experiment using the extension's real window lifecycle, not fresh Playwright browser contexts.

1. Put distinct sentinel data in the regular profile and in an Incognito session: cookies, localStorage, sessionStorage, IndexedDB, Cache Storage, and a Service Worker registration.
2. Persist necessary experiment metadata in the extension's normal repository.
3. Close every Incognito window belonging to the managed workspace and observe removal. Confirm the inventory is empty before recreating it. Do not retain an Incognito helper page or hidden client during the reset.
4. Create the replacement window on a neutral page, then inspect the target origin before normal app scripts or worker registration can recreate state.
5. Verify old site data and registrations are absent, regular-profile sentinels are unchanged, and the extension repository remains readable.
6. Run a negative control that leaves another Incognito window open. It must demonstrate why closing only one window is insufficient and why the dashboard blocks that condition.
7. Stress immediate close/reopen. Window-removal events are not, by themselves, evidence that every asynchronous browser teardown step is complete. Investigate any surviving state; do not hide it behind an arbitrary sleep.

Deliver commands, repeat counts, observed failures, browser version, and the actual supported reset claim. Stop expansion if a reliable boundary cannot be demonstrated.

## Stage 2 — Restore before application bootstrap

Fresh Incognito removes old workers, but does not itself solve origin access or asynchronous restoration. An extension-origin page cannot directly restore a website's IndexedDB. `document_start` orders content-script startup; it does not await an asynchronous restore before page scripts run.

Investigate a small temporary bootstrap barrier using official APIs. One candidate is a tab-scoped `declarativeNetRequest` rule that appends a restrictive CSP to network document responses during bootstrap, while an isolated-world content script restores native origin storage. This is an unvalidated hypothesis, not a selected solution.

For that candidate, demonstrate all of the following before relying on it:

- Register rules and content scripts before target navigation; include inline scripts, modules, workers, subframes, redirects, and relevant subresources in the experiment.
- Preserve existing site CSP; do not weaken or replace it with a more permissive policy.
- Confirm no old Service Worker can serve the bootstrap document. DNR does not modify every response synthesized by a worker or read from Cache Storage.
- Resolve the new Incognito cookie store from the managed tab; restore cookies with explicit `storeId` before the first authenticated target request. Never hard-code a cookie store ID or fall back to the normal store.
- Bound all network access during bootstrap. The initial document request still reaches a server; a script barrier is not a guarantee of zero server-side effects. Record allowed navigation and redirect behavior.
- Restore IndexedDB, localStorage, sessionStorage, and supported caches from an isolated-world context with the intended origin and partition.
- Wait for durable completion of storage transactions, remove the temporary barrier, and perform the final navigation/reload in the same managed tab.
- Only then let the app run and register its Service Worker normally.
- Verify failure, extension restart, and tab closure leave the UI in an explicit failed state. Clean up temporary rules and scripts; never silently release a partial restore into normal operation.

Use a conventional test application whose first inline script reads storage and starts an IndexedDB operation immediately. Observation is permitted; awaiting an extension handshake, a special restore route, or test-runner script suspension is not. Add artificial restore latency so a missing barrier fails deterministically. Assert the initial values observed by the app, not merely its state after a later corrective reload.

If this candidate fails, investigate only a small number of simpler supported alternatives. Do not turn the experiment into a general browser interception framework.

## Stage 3 — Snapshot fidelity and consistency

Implement full snapshots progressively: IndexedDB and localStorage first, then sessionStorage, cookies, and Cache Storage. Use a versioned format distinct from RECnRun's existing domain `Snapshot`, with session ID, URL, origin set, adapter capabilities, capture times, and completion status.

- Preserve IndexedDB schema, versions, indices, explicit keys, inline/out-of-line keys, composite keys, empty stores, and supported structured values. Handle extra databases and schema changes through the fresh-context restore.
- Validate the complete application-to-extension-to-application transport with Date, Blob, ArrayBuffer, and other declared types. Do not silently pass complex values through JSON messaging. If using Chrome's structured-clone messaging option, verify the actual Chrome version, manifest support, WXT output, and runtime behavior.
- Test `autoIncrement` after deleting the highest generated key. Do not describe reconstructed records as preservation of an inaccessible internal generator state without evidence.
- Use readonly transactions spanning the relevant stores within each database. Confirm writes with transaction completion, not request success alone.
- Atomically publish a completed snapshot in extension IndexedDB. An interrupted capture must leave the previous completed snapshot usable.
- Never close the current workspace as part of a managed switch until its snapshot has committed. If capture or persistence fails, keep the workspace and report failure.
- Explicitly test writes from a page, worker, and Service Worker during capture and between capture completion and closure. Pause of RECnRun recording does not pause those writers.
- Define the supported consistency boundary. There is no assumed atomic transaction across databases, cookies, Web Storage, and caches. If reliable capture requires a quiescent application, state and test that restriction.
- Cache responses require a supported serialization format for requests, headers, status, and bodies. Explicitly classify opaque responses and unsupported reconstruction cases. Cache Storage is not the HTTP cache or a Service Worker registration backup.
- Capture all necessary authorized origins and cookie scopes. Start with one first-party application; third-party SSO, cross-origin frames, storage partitions, and additional backend domains are separate declared capabilities.
- A new session is explicitly empty. Resuming a missing, invalid, or incomplete snapshot is an error, never an implicit new session.
- Never log credentials, tokens, cookie contents, or snapshot payloads.

The lifecycle is: validate → capture current state → commit snapshot → close last Incognito window → verify reset boundary → create neutral workspace → resolve Incognito cookie store → restore behind bootstrap barrier → release app → verify readiness → mark destination active.

`Suspend` stops after closure. `Resume` starts from an existing completed snapshot. Do not claim changes after the snapshot cutoff were preserved unless the experiment proves it. Unexpected user closure can lose unsaved changes; it cannot promise an asynchronous final backup after the tab is gone.

## Stage 4 — PWA compatibility, including Zephyr

First establish a baseline of the unmodified application in ordinary Incognito with no snapshot interception. If it already fails there, separate that browser limitation from a RECnRun regression.

Test the local PWA fixture with native Service Workers enabled: registration, activation, controller acquisition, worker-initiated authenticated fetch, worker access to IndexedDB and Cache Storage, and offline reload after activation. Ensure workers use the same restored native state as the page.

For Zephyr at `https://zephyr-tq.one.be/zephyr-domes-frontend/`, the planning review could retrieve the public HTML, JavaScript entrypoint, and Angular `ngsw.json`. That establishes useful test targets, not a successful authenticated or runtime validation. Use authorized test accounts for the actual experiment.

Exercise A → B → A → C → A with distinct identity markers. Verify the initial app reads, worker responses, and authenticated requests all belong to the active identity; the normal-profile login remains unchanged.

Destroying Incognito also destroys worker registrations. Resumption initially means restoring data and allowing the application to reinstall its worker; it does not preserve a running worker, its queues, or its registration verbatim. Test first load, subsequent controlled reload, and app-version changes separately. Offline use after reinstall is different from resuming a destroyed context while already offline.

Do not bypass PWA failures by disabling Service Workers, removing the app's PWA features, injecting a test handshake, or testing a different app as if it proved Zephyr compatibility. Push, installation, permission prompts, and SSO must be compared against the native Incognito baseline before being promised.

## Optional comparison — Reuse the Incognito context

Only investigate this after the primary route has results, or if a specific primary-route blocker justifies it. Keep it a bounded experiment.

Keeping native Service Workers enabled while reusing their browser context leaves live connections, worker state, and old caches to manage during replacement. One active user reduces concurrent identities but does not stop background writes. Importing SplitSession's namespaces would make worker/page storage disagreement another problem.

Compare runtime compatibility, data fidelity, first-load behavior, implementation size, and switch latency. Do not select the reused-context route merely to avoid a visible window close/open.

## Required E2E and delivery gate

Use the existing real extension, Docker, and Xvfb infrastructure. Perform window creation and closure through the extension. Include dashboard startup with and without Incognito access; existing-window blockers and dashboard closure action; concurrent dashboard commands; unexpected windows; normal-tab rejection; suspend/resume; missing snapshot; failed capture/persistence/restore; extension restart; stale messages; and user closure during operations.

Run the full identity sequence, reopen a saved session after browser restart, and demonstrate the normal profile remains unchanged. Include binary/type fidelity, schema changes, PWA worker behavior, bootstrap latency, and a database with at least 10,000 records of documented approximate size. Measure capture, transport, persistence, teardown, bootstrap, restore, PWA readiness, and total switch time separately.

Every behavior change needs observed red/green evidence under repository rules. `vp run verify` must exit 0 before reporting code work complete. Update architecture and permission guards together with the implemented capability; do not relax quality thresholds or expand permissions without a demonstrated need. Keep public website data access unchanged.

Report GO, CONDITIONAL GO, or NO-GO separately for native reset, data fidelity, startup barrier, capture consistency, local PWA compatibility, and Zephyr. An untested Zephyr login is “not validated,” not GO. A POC can conclude successfully with evidence that a required product property is infeasible.

Deliver the minimal code justified by the experiments and `docs/POC-ORIGIN-SNAPSHOT.md`, recording base/source commits, environment, permissions, exact commands, negative controls, timing results, restrictions, and recommendation. Do not build all adapters or a polished UI after an essential feasibility gate fails.

## References inspected during planning

- [RECnRun baseline manifest configuration](https://raw.githubusercontent.com/RECnRun/recnrun/44c154da29860c7a8df829e902b177df5ce2ba2a/apps/extension/wxt.config.ts)
- [SplitSession worker patches](https://raw.githubusercontent.com/Misyuk-T/splitsession/475afe88cd1ec7208b2a5510759036955032e0d4/src/content/shim/patches/workers.ts)
- [SplitSession patch installation](https://raw.githubusercontent.com/Misyuk-T/splitsession/475afe88cd1ec7208b2a5510759036955032e0d4/src/content/shim/install.ts)
- [SplitSession IndexedDB namespace](https://raw.githubusercontent.com/Misyuk-T/splitsession/475afe88cd1ec7208b2a5510759036955032e0d4/src/content/shim/patches/indexed-db.ts)
- [SplitSession license](https://raw.githubusercontent.com/Misyuk-T/splitsession/475afe88cd1ec7208b2a5510759036955032e0d4/LICENSE)
- [Chrome Incognito lifecycle](https://support.google.com/chrome/answer/95464?hl=en)
- [Extension Incognito modes](https://developer.chrome.com/docs/extensions/reference/manifest/incognito)
- [Content-script timing and CSP](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [DNR operations and Service Worker limitations](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)
- [Cookie stores](https://developer.chrome.com/docs/extensions/reference/api/cookies)
- [Structured-clone messaging option](https://developer.chrome.com/blog/structured-clone-messaging)
- [IndexedDB specification](https://w3c.github.io/IndexedDB/)
- [Service Worker registration and lifetime](https://www.w3.org/TR/service-workers/)
- [Zephyr public entrypoint](https://zephyr-tq.one.be/zephyr-domes-frontend/main.js)
- [Zephyr Angular Service Worker manifest](https://zephyr-tq.one.be/zephyr-domes-frontend/ngsw.json)

Planning evidence: source inspection and public HTTP retrieval only. No browser reset, snapshot restore, authenticated Zephyr flow, or extension test was executed as part of preparing this plan.
