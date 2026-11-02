# 0002: Retire the extension and the bridge

## Status

Accepted on 2026-11-02 by the owner ([PLAN.md §2](../plan/PLAN.md#2-decisions), decision 2; [PLAN.md §8](../plan/PLAN.md#8-assumptions-confirmed), assumptions 1 and 2). Carried out in F0.1.

## Context

M0 built three pieces around a browser extension:

- `apps/extension`: a WXT Manifest V3 extension that stored a versioned `Snapshot` of recordings and answered read requests;
- `packages/bridge`: the versioned `window.postMessage` protocol between recnrun.com and the extension's content script;
- `packages/domain`: the Valibot schemas for `Recording` and `Snapshot` that both sides validated against.

[0001](0001-local-service-over-cdp.md) moves data ownership to a local service that drives Chrome over CDP. The extension's storage, the bridge, and the explorer on recnrun.com no longer have a role, and keeping them would double the security model and the test surface for code no feature uses.

## Decision

- Delete `apps/extension` and `packages/bridge`, with every script, test project, lint override, dependency rule, Knip entry, Docker step, and catalog entry that named them. Copies are not kept: the code stays in the history of `master` and in the tags `archive/explorations-2026-10-30` and `archive/workflow-recording-2026-11-02`.
- Delete `packages/domain` too. Once the explorer is gone nothing imports it, and the target layout has no such package: `packages/protocol` (F0.2, schemas in F0.3) holds the new contracts. Its `Recording` and `Snapshot` shapes are not carried over; the flow, run, and event schemas replace them.
- Keep `apps/website` as the public landing on GitHub Pages and the install guide for `@recnrun/cli`. It no longer detects an extension, shows an install banner, or reads user data. It keeps its strict CSP and the brand stylesheet. The localhost UI of the tool is a separate app (`apps/ui`, F0.2), served by the service.
- Remove the `extension.md` scoped rule and the `adding-a-bridge-message` skill. `packages.md` replaces `domain.md`, and the `adding-a-service-command` skill replaces the bridge skill.

## Consequences

- recnrun.com holds and reads no user data. Its CSP still matters as hygiene for the page that hands out install commands, but a script injection there no longer reaches recordings.
- The M0 acceptance tests that needed the extension (`explorer.spec.ts`, `install-banner.spec.ts`, `origin-guard.spec.ts`, the popup font check) are deleted with it. `landing.spec.ts` checks the landing and its CSP; `icons.spec.ts` and `typography.spec.ts` still describe the website.
- Playwright end-to-end tests no longer need a headed Chromium with an unpacked extension. The Docker image keeps Xvfb for component tests and for Google Chrome in the browser layer (F0.6).
- Nothing migrates: M0 could not record, so no user data exists in the old storage format.
- The production manifest guard (`test:extension-manifest`) leaves `vp run verify`. The service's own guards (loopback, token, no egress) arrive with the service in F2.1.
