# AGENTS.md

RECnRun is a local tool that drives the installed Google Chrome over the Chrome DevTools Protocol (CDP), records flows, and replays them with no AI involved. A Node.js service on the user's machine owns the data; a CLI (`npx @recnrun/cli`), a localhost UI, and an optional MCP server are its clients ([ADR 0001](docs/adr/0001-local-service-over-cdp.md)). The M0 browser extension and its bridge are retired ([ADR 0002](docs/adr/0002-retire-extension-and-bridge.md)). It is a Vite+ monorepo:

- `apps/service`: `@recnrun/service`, the local service: loopback API, MCP adapter, and the UI's server.
- `apps/ui`: `@recnrun/ui`, the Preact SPA the service serves on localhost.
- `apps/cli`: `@recnrun/cli`, the command line published to npm (`setup`, `open`, `run`, `doctor`).
- `apps/fixture`: `@recnrun/fixture`, the controllable test application the browser tests drive.
- `apps/website`: Preact SPA at recnrun.com, deployed to GitHub Pages: the public landing and install guide. It holds no user data.
- `packages/protocol`: `@recnrun/protocol`, the Valibot schemas of every shape that crosses a boundary.
- `packages/engine`: `@recnrun/engine`, sessions, steps, and locator resolution over an adapter interface.
- `packages/adapter`: `@recnrun/adapter`, that interface implemented over Playwright and CDP.
- `packages/persistence`: `@recnrun/persistence`, flow folders, revisions, the journal, and the SQLite index.
- `packages/brand`: `@recnrun/brand`, the Mona Sans font and the stylesheet every app imports.
- `tests/`: Playwright end-to-end tests (`tests/e2e`), browser tests against Google Chrome over CDP (`tests/browser`), and Docker runner checks (`tests/container`).

The workspaces are skeletons until the phases of [PLAN.md](docs/plan/PLAN.md) fill them; [ARCHITECTURE.md](docs/ARCHITECTURE.md#target-layout) has the layout and what each may import.

Durable decisions live in `docs/`:

- [PRODUCT_BRIEF.md](docs/PRODUCT_BRIEF.md): concepts and product rules.
- [ARCHITECTURE.md](docs/ARCHITECTURE.md): workspaces, layers, the security model, and the toolchain.
- [adr/](docs/adr/README.md): architecture decision records.
- [MILESTONES.md](docs/MILESTONES.md): delivery and acceptance.
- [BRAND.md](docs/BRAND.md): logo, palette, contrast, typography, and CSS tokens.
- [plan/PLAN.md](docs/plan/PLAN.md): the phased implementation plan of the local engine, with [plan/CHECKLIST.md](docs/plan/CHECKLIST.md) (progress and resume protocol) and [plan/MANUAL_VALIDATION.md](docs/plan/MANUAL_VALIDATION.md) (checks that need a person).

Update the relevant doc when a change alters what it describes.

## Commands

Vite+ (`vp`) is the only toolchain. `vp <name>` runs a built-in command and `vp run <name>` runs a `package.json` script or `vite.config.ts` task, so they can differ: `vp test` is plain Vitest, while `vp run test` is the project suite. Vite+ docs are in `node_modules/vite-plus/docs`. Run `vp env doctor` when setup or package-manager behavior looks wrong.

| Command                                                           | Purpose                                                                       |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `vp install`                                                      | After pulling, before starting work                                           |
| `vp run dev` (alias of `vp run dev:website`)                      | Website dev server on port 5173                                               |
| `vp run dev:fixture`                                              | Fixture application on ports 4600 and 4601, the browser tests' target         |
| `vp run clean`                                                    | Delete builds, artifacts, and caches                                          |
| `vp check` (`--fix` to format)                                    | Format (Oxfmt), lint (Oxlint), and type check while editing                   |
| `vp run deps`                                                     | Architecture boundaries (dependency-cruiser)                                  |
| `vp run test:unit`, `test:components`, `test:e2e`, `test:browser` | One test layer: Node, Vitest Browser Mode, Playwright, Google Chrome over CDP |
| `vp run test`                                                     | All four layers                                                               |
| `vp run test:coverage`                                            | Coverage with thresholds                                                      |
| `vp run dead-code`, `vp run duplication`                          | Knip; jscpd                                                                   |
| `vp run docs:check`                                               | Relative Markdown links and anchors resolve                                   |
| `vp run capabilities:generate`                                    | Regenerate `docs/CAPABILITIES.md` from the capability matrix                  |
| `vp run schema:generate`                                          | Regenerate the committed JSON Schema of `packages/protocol`                   |
| `vp run test:e2e -- tests/e2e/landing.spec.ts -g ''`              | Targeted Playwright run (arguments go after `--`)                             |
| `vp run verify`                                                   | Full gate (`vp run ready` is an alias)                                        |

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
  - container, hook, and script checks;
  - coverage (at least 80% lines, statements, and functions; 75% branches);
  - Knip and jscpd (at most 4% duplication);
  - `docs:check` (every relative Markdown link and anchor resolves);
  - workspace builds.
- When a gate fails, fix the cause. Never lower thresholds, delete or skip tests, exclude code from analysis, add `@ts-ignore`/`@ts-nocheck`, disable lint rules, or loosen `.dependency-cruiser.cjs` to pass.
- An architecture change (a new layer, package, or allowed dependency) updates `docs/ARCHITECTURE.md` and `.dependency-cruiser.cjs` in the same change, with the reason.
- Never bypass Git hooks: no `--no-verify`/`-n`, `VP_GIT_HOOKS=0`, `HUSKY=0`, `core.hooksPath` changes, or `vp hooks disable`. Agent hooks in `scripts/agent-hooks/` deny these and run `vp check` and `vp run deps` when you stop (after three consecutive failures they let you stop with a warning; Git hooks still gate the commit).
- Keep TypeScript strict and prefer `unknown` with narrowing over `any`. Lint caps `complexity` at 10, `sonarjs/cognitive-complexity` at 15, nesting depth at 3, functions at 50 lines, files at 300 lines, and parameters at 4, and requires `vite-plus` imports over `vite`/`vitest`.
- In app source and tests, import from `src` through the `@/` alias, never with `../` paths (lint rejects them). `./` imports are fine.
- Validate every request, message, and stored value with the `packages/protocol` schemas at the boundary where it enters (the service API, page instrumentation, files read from disk).
- Never open a network connection to a host other than loopback from the service, the CLI, or the MCP server; tests enforce it with `RECNRUN_FORBID_EGRESS=1`.
- Write code, comments, docs, UI copy, and diagnostics in English.
- In CSS, write hex colors only in the palette tokens at the top of each stylesheet; rules use semantic tokens ([BRAND.md](docs/BRAND.md#tokens)).
- Keep comments sparse: one line stating a reason or constraint, never a restatement of the code.
- Add tests together with new engine logic, protocol schemas, service commands, and components.
- Never push to `master` without explicit authorization: a push to `master` deploys the website.

## Commits

Do not use Conventional Commits. Write one imperative English sentence: capitalized, no type or scope prefix, no trailing period, under 72 characters. Example: `Add a service command for deleting a flow`.

Add a body only when the reason is not obvious from the subject. For behavior changes, the body has `Red:` and `Green:` lines with the test commands. The `commit-msg` hook enforces the subject format and, for commits that touch `apps/*/src`, `apps/*/build`, or `packages/*/src`, requires those lines plus a staged test, or a `No-behavior-change: <reason>` line.

## Scoped rules

Claude Code loads these automatically. Codex must read the matching file before editing these paths.

| Rule                        | Paths                                                                                                                        | Covers                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `.claude/rules/website.md`  | `apps/website/**`                                                                                                            | Landing scope, `ui`/`features`/`app` layers, CSP |
| `.claude/rules/packages.md` | `packages/**`                                                                                                                | Package purity, schemas, versioning, no egress   |
| `.claude/rules/tests.md`    | `tests/**`, `**/tests/**`, `playwright*.config.ts`, `**/vitest*.config.ts`, `scripts/test-container.mjs`, `Dockerfile.tests` | Test layers, planned layers, Docker runs         |

## Skills

Skills live in `.agents/skills/` (Codex). `.claude/skills` is a symlink to the same directory (Claude Code).

- `adding-a-service-command`: checklist for a new command of the local service, from protocol schema to contract test, UI, and docs.

Claude Code subagents live in `.claude/agents/`. `plan-implementer` carries out delegated plan tasks with red/green tests, one commit per task, and checklist evidence.
