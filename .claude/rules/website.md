---
paths:
  - "apps/website/**"
---

# Website

[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#website) defines the layers. Dependency-cruiser enforces them:

| Folder                | Holds                                                            | May import                                |
| --------------------- | ---------------------------------------------------------------- | ----------------------------------------- |
| `src/ui`              | Presentational components and pure helpers; props in, markup out | `src/ui`                                  |
| `src/services`        | Adapters to the outside world; `extension.ts` owns the bridge    | `@recnrun/bridge`                         |
| `src/features/<name>` | State and views for one capability                               | its own feature, `src/ui`, `src/services` |
| `src/app`             | Composition: picks what to show from the feature states          | everything above                          |
| `src/main.tsx`        | Mounts `App` with the real gateway                               | `src/app`, `src/services`                 |

- Features never import each other; share through `src/ui` or compose in `src/app`.
- The website never reads the user's data; the extension's dashboard shows it in a frame over the site.
- Components receive the gateway as a prop, so component tests pass a fake gateway (`apps/website/tests/fake-gateway.ts`) instead of a fake extension.
- Preact with `jsxImportSource: "preact"`; hooks from `preact/hooks`.
- **CSP.** `build/content-security-policy.ts` adds a strict `<meta>` CSP to production builds (GitHub Pages sends no headers). Keep scripts and styles in files: no inline `<script>`, `style=""` attributes, or `eval`. The end-to-end suite fails on any CSP violation.
- `build/not-found-page.ts` copies the built `index.html` to `404.html`, so GitHub Pages serves the app for deep links like `/recordings/<id>`; do not remove it.
- `privacy/index.html` is the privacy policy, a second build entry (`build.rolldownOptions.input`) that the Chrome Web Store listing links to. Keep it a real file: a route served by `404.html` gets status 404.
- `public/CNAME` keeps the custom domain on GitHub Pages; do not remove it.
