# Brand

The logo, the palette, the typography, and how the website and the extension popup use them.

## Logo

The logo is a **record dot over a play triangle**: REC, then Run. `scripts/logo.mjs` holds its geometry and colors, and `vp run logo` regenerates every file drawn from it; edit the scripts, never the outputs:

| File                                      | Script                 | Background                       |
| ----------------------------------------- | ---------------------- | -------------------------------- |
| `apps/website/icons/favicon.svg`          | `scripts/favicon.mjs`  | Transparent                      |
| `apps/extension/public/icon/<size>.png`   | `scripts/logo-png.mjs` | Transparent; 16, 32, 48, 128 px  |
| `apps/website/icons/favicon.ico`          | `scripts/logo-png.mjs` | Transparent; 16, 32, 48 px       |
| `apps/website/icons/apple-touch-icon.png` | `scripts/logo-png.mjs` | Transparent; 180 px              |
| `docs/logo.png`                           | `scripts/logo-png.mjs` | Transparent; 512 px, for avatars |

The designer's source art is `docs/brand/logo-fundo-transparente.svg` (and its PNG export); it is input, not output, and the scripts copy its numbers rather than read it.

No file has a tile: the three colors read on both light and dark backgrounds, so one file serves both themes. The extension icons are PNG because Chrome rejects SVG manifest icons. iOS browsers ignore SVG favicons, so the website also links the ICO and the touch icon; `index.html` lists the ICO before the SVG, with `sizes="32x32"`, so desktop browsers still pick the SVG. iOS fills the touch icon's transparency with black. The website icons live outside `public/` so the build gives them content-hashed names; browsers cache favicons for weeks, and only a new name makes them fetch a changed logo. `docs/logo.png` is the avatar for the GitHub organization and social profiles; it has a wider margin so a circular crop keeps the triangle's corners. The script rasterizes circles and polygons itself (8 × 8 samples per pixel), so it needs no browser or image library. WXT finds `public/icon/<size>.png` and lists them in the manifest; `vp run test:extension-manifest` fails if a production build ships without them.

- **Layers.** Painted bottom to top: a red disc (center 259, 217; radius 162 in the source art's inner coordinates), a green triangle pointing right (96.5, 230 / 381, 392.5 / 96.5, 555), and the same triangle clipped to the disc in yellow, so the overlap reads as a third color instead of a hidden corner.
- **Box.** The union of the layers is centered in a 32 × 32 box (the favicon's view box), 1 unit from the top and bottom.
- **Colors.** Red `#f3362b`, green `#30b050`, and yellow `#fecc03`, on a transparent background. They live in `scripts/logo.mjs` only; the UI palette below is separate.

## Palette

| Token               | Hex       | Role                      |
| ------------------- | --------- | ------------------------- |
| `--brand-green`     | `#1f883d` | Button fill in light mode |
| `--brand-green-dim` | `#238636` | Button fill in dark mode  |
| `--brand-red`       | `#c62a21` | Popup links in light mode |
| `--brand-coral`     | `#ff5c5f` | Popup links in dark mode  |
| `--brand-ink`       | `#1c1d21` | Text in light mode        |
| `--brand-paper`     | `#f6f7f9` | Light page background     |

Grays (`--gray-0` … `--gray-950`) are the neutral surfaces, borders, and secondary text.

### Where the accent goes

Buttons follow GitHub's primary button: the same greens as [Primer](https://primer.style/) (`#1f883d` light, `#238636` dark) with white text, so a call to action looks like the one developers already click on GitHub. Red is not a button color: it means recording, and a red button reads as stop or delete. Red stays for links in the popup and for the logo. Structure stays neutral: surfaces, cards, borders, and dividers use the grays, and buttons have no border.

The logo red `#f3362b` is too light for white text (3.91:1) and too dark for ink text (4.31:1), so links use a deeper red in light mode and the brighter coral in dark mode. Contrast (WCAG 2.2 ratios):

| Use                  | Light mode                 | Dark mode                    |
| -------------------- | -------------------------- | ---------------------------- |
| Button fill and text | green with white: 4.52:1   | dim green with white: 4.63:1 |
| Link                 | red on white popup: 5.59:1 | coral on dark popup: 5.87:1  |

## Typography

Text follows [GitHub's brand typography](https://brand.github.com/foundations/typography): [Mona Sans](https://github.com/github/mona-sans), in its default width, which GitHub uses for everything outside special events.

| Role     | Element | Style                                                |
| -------- | ------- | ---------------------------------------------------- |
| Title    | `h1`    | Bold; the optical size axis gives it the display cut |
| Headline | `h2`    | Bold                                                 |
| Body     | `body`  | Medium (500)                                         |

- **File.** `MonaSansVF[opsz,wght].woff2` from release v2.0.27, renamed `MonaSansVF.woff2`, with its `OFL.txt`. It is a variable font: weights 200 to 900 and the optical size axis in one 137 kB file. Italics, other widths, and Mona Sans Mono are left out until the UI uses them.
- **Self-hosted, once.** The website's CSP allows fonts from its own origin only, so the apps bundle the font instead of loading it from a CDN. It lives in `packages/brand/src/fonts/`; `packages/brand/src/mona-sans.css` declares it and sets the body's family, weight, and ligatures, and each app's entry imports that stylesheet before its own, which sets size and line height. `font-display: swap` shows the fallback until the font arrives; the site does not preload it, because `index.html` can name the file only by a path into another package, which the dev server does not serve.
- **No ligatures, no tracking.** Ligatures are off, as GitHub asks for headlines and body copy, and letter spacing is never set: Mona Sans adjusts it by size. Set fonts with longhands: the CSS minifier moves a `font` shorthand after the other declarations, and the shorthand would turn ligatures back on.

`tests/e2e/typography.spec.ts` checks that both apps load the font and keep ligatures off.

## Tokens

Each stylesheet (`apps/website/src/app/app.css`, `apps/extension/src/popup/popup.css`) opens with a `:root` block in two layers:

1. **Palette:** `--brand-*` and `--gray-*`. The only place a hex color is written.
2. **Semantic:** `--surface`, `--card`, `--border`, `--text`, `--muted`, `--accent`, `--accent-text`, `--link`. Each points to a palette token, and the `prefers-color-scheme: dark` block repoints them.

Rules use semantic tokens only: never write a hex color in a property, and never reference a palette token outside the `:root` blocks. A new color is a new palette token plus a semantic token for its role. The website and the popup are separate apps that share no code, so each file repeats the palette tokens it uses; keep their values identical to this table.
