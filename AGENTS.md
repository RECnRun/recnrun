# AGENTS.md

RECnRun records and replays browser sessions for developers. The extension stores the user's data; the website at recnrun.com detects the extension and asks to install it when it is missing. When it is installed, the site brings the extension's dashboard, its own tab, to the front; the toolbar icon and the profile's first window open it too. It is a Vite+ monorepo:

- `apps/extension`: WXT Chromium (MV3) extension with a Preact dashboard page. It owns the data and its UI.
- `apps/website`: Preact SPA at recnrun.com, deployed to GitHub Pages. It never reads the user's data.
- `packages/domain`: `@recnrun/domain`, Valibot schemas and types for Recording and the stored Snapshot.
- `packages/bridge`: `@recnrun/bridge`, the versioned `window.postMessage` protocol between the website and the extension's content script.
- `packages/brand`: `@recnrun/brand`, the Mona Sans font and the stylesheets both apps import.
- `tests/`: Playwright end-to-end tests (`tests/e2e`) and Docker runner checks (`tests/container`).

Durable decisions live in `docs/`:

- [PRODUCT_BRIEF.md](docs/PRODUCT_BRIEF.md): concepts and product rules.
- [ARCHITECTURE.md](docs/ARCHITECTURE.md): packages, layers, the bridge protocol, the security model, and the toolchain.
- [MILESTONES.md](docs/MILESTONES.md): delivery and acceptance.
- [BRAND.md](docs/BRAND.md): logo, palette, contrast, typography, and CSS tokens.
- [POCS.md](docs/POCS.md): proofs of concept behind architecture decisions, and what they found.
- [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md): problems that took investigation, their causes, and their solutions.

Update the relevant doc when a change alters what it describes.

## Commands

Vite+ (`vp`) is the only toolchain. `vp <name>` runs a built-in command and `vp run <name>` runs a `package.json` script or `vite.config.ts` task, so they can differ: `vp test` is plain Vitest, while `vp run test` is the project suite. Vite+ docs are in `node_modules/vite-plus/docs`. Run `vp env doctor` when setup or package-manager behavior looks wrong.

| Command                                                    | Purpose                                                              |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| `vp install`                                               | After pulling, before starting work                                  |
| `vp run dev`                                               | Website (port 5173) and extension dev build in Chrome, together      |
| `vp run dev:website`, `vp run dev:extension`               | One of them alone; the extension's Chrome keeps a persistent profile |
| `vp run clean`                                             | Delete builds, artifacts, caches, and the dev Chrome profile         |
| `vp check` (`--fix` to format)                             | Format (Oxfmt), lint (Oxlint), and type check while editing          |
| `vp run deps`                                              | Architecture boundaries (dependency-cruiser)                         |
| `vp run test:unit`, `test:components`, `test:e2e`          | One test layer: Node, Vitest Browser Mode, Playwright with extension |
| `vp run test`                                              | All three layers                                                     |
| `vp run test:coverage`                                     | Coverage with thresholds                                             |
| `vp run dead-code`, `vp run duplication`                   | Knip; jscpd                                                          |
| `vp run test:e2e -- tests/e2e/dashboard-tab.spec.ts -g ''` | Targeted Playwright run (arguments go after `--`)                    |
| `vp run verify`                                            | Full gate (`vp run ready` is an alias)                               |

Test commands and `verify` run in Docker, so start Docker Desktop first. If Docker fails, the command fails; it never falls back to host browsers. `:local` variants (`vp run test:e2e:local`) and the built-in `vp test` run on the host and are for debugging only. Logs and failure artifacts are in `.artifacts/docker/<run-id>/`.

## Rules

- **IMPORTANT: Exercise every change before reporting it.** This covers everything you modify: code, config, hooks, agent instructions, docs, and scripts. Run or observe each change where it takes effect; never infer that it works.
  - A throwaway check is enough. It does not have to become a persistent test.
  - Examples:
    - a hook: trigger it;
    - agent instructions, rules, or skills: confirm both Claude Code and Codex load them (`codex exec --ephemeral -s read-only`);
    - a doc: its links resolve and its commands run;
    - UI: see it in a browser.
  - Run experiments that need a broken state in a scratch copy, never in the shared checkout.
  - End every report with what you exercised and the result. Name anything you could not exercise and why; partly tested work is not done.
- **Red/green testing.** Applies to every behavior change and every new test.
  1. Run the targeted test against the unfixed behavior, or a controlled negative condition, and see it fail for the expected reason.
  2. Make the change.
  3. Rerun the same command and see it pass.

  Keep negative controls out of the final code. Report both commands and their outcomes; a test seen only passing is not validated.

- **Definition of done.** A code task is not done until `vp run verify` exits 0. It runs:
  - check, and lint with warnings as errors;
  - architecture boundaries;
  - all test layers;
  - container and hook checks;
  - coverage (at least 90% lines, statements, and functions; 85% branches overall, and at least 80% lines, statements, and functions; 75% branches in every file that has executable code), and a check that the measured files are every `.ts`/`.tsx` under `apps/*/src` and `packages/*/src` except tests, the entrypoints, and `main.tsx`;
  - Knip and jscpd (at most 4% duplication);
  - workspace builds and the production manifest guard.
- When a gate fails, fix the cause. Never lower thresholds, delete or skip tests, exclude code from analysis, add `@ts-ignore`/`@ts-nocheck`, disable lint rules, or loosen `.dependency-cruiser.cjs` to pass.
- An architecture change (a new layer, package, or allowed dependency) updates `docs/ARCHITECTURE.md` and `.dependency-cruiser.cjs` in the same change, with the reason.
- Never bypass Git hooks: no `--no-verify`/`-n`, `VP_GIT_HOOKS=0`, `HUSKY=0`, `core.hooksPath` changes, or `vp hooks disable`. Agent hooks in `scripts/agent-hooks/` deny these and run `vp check` and `vp run deps` when you stop (after three consecutive failures they let you stop with a warning; Git hooks still gate the commit).
- Keep TypeScript strict and prefer `unknown` with narrowing over `any`. Lint caps `complexity` at 10, `sonarjs/cognitive-complexity` at 15, nesting depth at 3, functions at 50 lines and 15 statements (150 lines and 30 statements in tests), files at 300 lines, and parameters at 4; it rejects identical functions, a string literal repeated three times in `apps/*/src` or `packages/*/src`, and conditions the types already decide (`typescript/no-unnecessary-condition`), and requires `vite-plus` imports over `vite`/`vitest`.
- In app source and tests, import from `src` through the `@/` alias, never with `../` paths (lint rejects them). `./` imports are fine.
- Validate every message and stored value with the `@recnrun/domain` or `@recnrun/bridge` schemas at the boundary where it enters; the content script never touches storage.
- Write code, comments, docs, UI copy, and diagnostics in English.
- In CSS, write hex colors only in the palette tokens of `packages/brand/src/base.css`; rules use semantic tokens ([BRAND.md](docs/BRAND.md#tokens)).
- Keep comments sparse: one line stating a reason or constraint, never a restatement of the code.
- Add tests together with new domain logic, protocol messages, handlers, and components.
- Never push to `master` without explicit authorization: a push to `master` deploys the website.

## Commits

Do not use Conventional Commits. Write one imperative English sentence: capitalized, no type or scope prefix, no trailing period, under 72 characters. Example: `Add a bridge message for deleting a recording`.

Add a body only when the reason is not obvious from the subject. For behavior changes, the body has `Red:` and `Green:` lines with the test commands. The `commit-msg` hook enforces the subject format and, for commits that touch `apps/*/src`, `apps/*/build`, or `packages/*/src`, requires those lines plus a staged test, or a `No-behavior-change: <reason>` line.

## Scoped rules

Claude Code loads these automatically. Codex must read the matching file before editing these paths.

| Rule                         | Paths                                                                                                                        | Covers                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `.claude/rules/extension.md` | `apps/extension/**`                                                                                                          | Entrypoints, allowed origins, messaging, storage |
| `.claude/rules/website.md`   | `apps/website/**`                                                                                                            | `ui`/`features`/`services`/`app` layers, CSP     |
| `.claude/rules/domain.md`    | `packages/**`                                                                                                                | Domain purity, schemas, protocol versioning      |
| `.claude/rules/tests.md`     | `tests/**`, `**/tests/**`, `playwright*.config.ts`, `**/vitest*.config.ts`, `scripts/test-container.mjs`, `Dockerfile.tests` | Test layers, extension fixture, Docker runs      |

## Skills

Skills live in `.agents/skills/` (Codex). `.claude/skills` is a symlink to the same directory (Claude Code).

- `adding-a-bridge-message`: checklist for a new website ↔ extension message, from schema to end-to-end test.

Claude Code subagents live in `.claude/agents/`. `plan-implementer` carries out delegated plan tasks with red/green tests, one commit per task, and checklist evidence.
