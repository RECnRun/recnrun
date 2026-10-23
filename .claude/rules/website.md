---
paths:
  - "apps/website/**"
---

# Website

[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#website) defines the layers. Dependency-cruiser enforces them:

| Folder                | Holds                                                            | May import                                        |
| --------------------- | ---------------------------------------------------------------- | ------------------------------------------------- |
| `src/ui`              | Presentational components and pure helpers; props in, markup out | `src/ui`, `@recnrun/domain` types                 |
| `src/services`        | Adapters to the outside world; `extension.ts` owns the bridge    | `@recnrun/bridge`, `@recnrun/domain`              |
| `src/features/<name>` | State and views for one capability                               | its own feature, `src/ui`, `src/services`, domain |
| `src/app`             | Composition: picks what to show from the feature states          | everything above                                  |
| `src/main.tsx`        | Mounts `App` with the real gateway                               | `src/app`, `src/services`                         |

- Features never import each other; share through `src/ui` or compose in `src/app`.
- Components receive the gateway or data as props, so component tests pass a fake gateway (`apps/website/tests/fake-gateway.ts`) instead of a fake extension.
- Preact with `jsxImportSource: "preact"`; hooks from `preact/hooks`.
- **CSP.** `build/content-security-policy.ts` adds a strict `<meta>` CSP to production builds (GitHub Pages sends no headers). Keep scripts and styles in files: no inline `<script>`, `style=""` attributes, or `eval`. The end-to-end suite fails on any CSP violation.
- Any data shown came from the extension and is user content: render it as text, never through `dangerouslySetInnerHTML`.
- `build/not-found-page.ts` copies the built `index.html` to `404.html`, so GitHub Pages serves the app for deep links like `/recordings/<id>`; do not remove it.
- `public/CNAME` keeps the custom domain on GitHub Pages; do not remove it.
