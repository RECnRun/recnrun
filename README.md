# RECnRun

Record a browser flow once, replay it whenever you need it, with no AI involved. RECnRun is a local tool: it drives the Google Chrome already installed on your machine through the Chrome DevTools Protocol (CDP), saves what you do as a declarative flow, and keeps flows and their evidence on your machine. [recnrun.com](https://recnrun.com) explains how to install it.

- [Product brief](docs/PRODUCT_BRIEF.md): concepts (flows, steps, locator lists, actors, runs, evidence, coverage) and product rules.
- [Architecture](docs/ARCHITECTURE.md): workspaces, layers, the security model, and the toolchain.
- [Decisions](docs/adr/README.md): why a local service over CDP, and why the M0 extension was retired.
- [Milestones](docs/MILESTONES.md) and the [plan](docs/plan/PLAN.md): phases F0 to F7 and their gates.
- [Brand](docs/BRAND.md): logo, colors, typography, and CSS tokens.
- [AGENTS.md](AGENTS.md): rules for contributors, human or AI.

## Install

The `@recnrun/cli` package is not published yet; the engine is being built in phases ([plan](docs/plan/PLAN.md)). Once it is, you will need Node.js 22.18 or later (24 LTS recommended) and Google Chrome 144 or later:

```sh
npx @recnrun/cli setup   # once; Chrome shows its own permission dialog
npx @recnrun/cli open    # opens RECnRun in your browser
```

While RECnRun is connected, Chrome shows a banner saying that the browser is being debugged.

On macOS, also allow the terminal you run RECnRun from to read Chrome's data (System Settings → Privacy & Security → Full Disk Access, or accept the prompt to access data from other apps), then restart the terminal; otherwise `doctor` reports Chrome as blocked.

## Development

Requirements: Node.js 22.18 or later, [Vite+](https://viteplus.dev) (`vp`), and Docker Desktop for tests.

```sh
vp install              # dependencies and Git hooks
vp run dev              # the website, at http://localhost:5173
vp run clean            # delete builds, test artifacts, and caches
```

## Quality gates

| Command                                           | Checks                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------- |
| `vp check`                                        | Formatting, lint (complexity, size, nesting, TypeScript rules), types   |
| `vp run deps`                                     | Architecture boundaries and import cycles                               |
| `vp run test:unit`, `test:components`, `test:e2e` | Node tests; components in Chromium; the built website in Playwright     |
| `vp run test:coverage`                            | Coverage of at least 80% lines, statements, and functions; 75% branches |
| `vp run dead-code`, `vp run duplication`          | Unused files, exports, and dependencies; duplicated code                |
| `vp run docs:check`                               | Relative Markdown links and anchors resolve                             |
| `vp run verify`                                   | All of the above, plus builds                                           |

Tests and `verify` run in Docker on a virtual display, so browser windows never open on your desktop. Results and failure artifacts are in `.artifacts/docker/<run-id>/`. Git hooks run the fast gates before each commit and `vp run verify` before each push, unless verify already passed on that exact commit with a clean working tree.

## Deployment

Pushing to `master` runs `vp run verify` and deploys `apps/website` to GitHub Pages (`.github/workflows/deploy-website.yml`). The repository's Pages source must be set to **GitHub Actions**.

## License

[Apache 2.0](LICENSE)
