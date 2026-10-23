# RECnRun

Record a browser session once, replay it whenever you need it: log in, fill long forms, and reproduce bugs in seconds. The browser extension keeps your data in your browser; [recnrun.com](https://recnrun.com) shows it.

- [Product brief](docs/PRODUCT_BRIEF.md): concepts (recordings and what comes next).
- [Architecture](docs/ARCHITECTURE.md): packages, layers, the website ↔ extension protocol, and the security model.
- [Milestones](docs/MILESTONES.md): what is done and what comes next.
- [Brand](docs/BRAND.md): logo, colors, typography, and CSS tokens.
- [AGENTS.md](AGENTS.md): rules for contributors, human or AI.

## Install the extension

The extension is not in the Chrome Web Store yet. To load it in Chrome, Edge, or Brave:

1. Build it: `vp install`, then `vp run extension#build`.
2. Open `chrome://extensions`, turn on **Developer mode**, and choose **Load unpacked**.
3. Select `apps/extension/.output/chrome-mv3`.
4. Open [recnrun.com](https://recnrun.com). The install banner is replaced by your recordings.

## Development

Requirements: Node.js 22.18 or later, [Vite+](https://viteplus.dev) (`vp`), and Docker Desktop for tests.

```sh
vp install              # dependencies, Git hooks, and WXT types
vp run dev              # website and extension together; Ctrl+C stops both
vp run dev:website      # only the website, at http://localhost:5173
vp run dev:extension    # only the extension, in Chrome opened at the website, reloaded on change
vp run clean            # delete builds, test artifacts, caches, and the dev Chrome profile
```

Development builds of the extension also run on `localhost`, so the local website talks to it. Production builds run only on recnrun.com; recnrun.app, recnrun.io, and recn.run redirect there.

The dev Chrome keeps its profile in `apps/extension/.wxt/chrome-data`, so extension data survives restarts. `vp run clean` resets it; the next `vp run dev` creates a fresh one. The website always uses port 5173 and fails if the port is busy, because the dev Chrome opens that URL.

## Quality gates

| Command                                           | Checks                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------- |
| `vp check`                                        | Formatting, lint (complexity, size, nesting, TypeScript rules), types   |
| `vp run deps`                                     | Architecture boundaries and import cycles                               |
| `vp run test:unit`, `test:components`, `test:e2e` | Node tests; components in Chromium; the website with the real extension |
| `vp run test:coverage`                            | Coverage of at least 80% lines, statements, and functions; 75% branches |
| `vp run dead-code`, `vp run duplication`          | Unused files, exports, and dependencies; duplicated code                |
| `vp run verify`                                   | All of the above, plus builds and the production manifest guard         |

Tests and `verify` run in Docker on a virtual display, so browser windows never open on your desktop. Results and failure artifacts are in `.artifacts/docker/<run-id>/`. Git hooks run the fast gates before each commit and `vp run verify` before each push.

## Deployment

Pushing to `master` runs `vp run verify` and deploys `apps/website` to GitHub Pages (`.github/workflows/deploy-website.yml`). The repository's Pages source must be set to **GitHub Actions**.

## License

[Apache 2.0](LICENSE)
