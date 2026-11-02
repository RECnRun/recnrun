---
paths:
  - "apps/website/**"
---

# Website

`apps/website` is the public landing at recnrun.com and the install guide for `@recnrun/cli`. It holds no user data and no engine, protocol, or UI code. [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#website) defines the layers; dependency-cruiser enforces them:

| Folder                | Holds                                                   | May import                      |
| --------------------- | ------------------------------------------------------- | ------------------------------- |
| `src/ui`              | Presentational components; props in, markup out         | `src/ui`                        |
| `src/features/<name>` | One part of the page with its content (`install-guide`) | its own feature, `src/ui`       |
| `src/app`             | Composition of the page                                 | everything above                |
| `src/main.tsx`        | Mounts `App`                                            | `src/app`, `@recnrun/brand` CSS |

- Features never import each other; share through `src/ui` or compose in `src/app`.
- The only workspace package the website imports is `@recnrun/brand` (`website-only-brand`).
- Preact with `jsxImportSource: "preact"`; hooks from `preact/hooks`.
- **CSP.** `build/content-security-policy.ts` adds a strict `<meta>` CSP to production builds (GitHub Pages sends no headers). Keep scripts and styles in files: no inline `<script>`, `style=""` attributes, or `eval`. The end-to-end suite fails on any CSP violation.
- Install commands are shown as text the visitor copies; keep them identical to the CLI's documented commands and say plainly what is not published yet.
- `public/CNAME` keeps the custom domain on GitHub Pages; do not remove it.
