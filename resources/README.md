# DiffGuide identity

The mark is the Diff pair, DiffGuide's companion: two stacked rounded bars, an added line (jade) over a removed line (grey), a little out of step, with two pill eyes on the top bar. Its look and motions are recorded in [docs/design/diff-pair-character.html](../docs/design/diff-pair-character.html).

- `icon.svg`: editable vector source, 256 × 256. A warm light tile with corners of radius 58 and a hairline edge. The pair sits on it inset by the page's framing (translate .1, .08, scale .8 of the unit square). Each bar has a darker edge under it; only the grey bar casts a soft bar-shaped shadow.
- `icon.png`: 256 × 256 RGBA PNG used by the extension manifest and Marketplace listing, rendered from `icon.svg`.
- `review.svg`: 24 × 24 one-color sidebar icon: the pair in `#C5C5C5`, its eyes masked out so the background shows through.
- `diffguide-icons-<hash>.woff`: icon font for menus, the sidebar and the status bar, built from `src/page/icons.ts` by `npm run icons`. See [docs/ICONS.md](../docs/ICONS.md).

Proportions on the unit square: bars x .18, width .64; top bar y .20, height .34, radius .12; bottom bar y .59, height .24, radius .10; bars offset ±.035; edge .045; eyes .075 × .13, .2 apart, centered on the top bar.

Palette, light: tile `#FFFDF9` to `#ECE7DF`; top bar `#1E8463` with a `#2A9D78` highlight at its top and `#125540` edge; white eyes; bottom bar `#A6ACA9` with `#767C79` edge; shadow `#0A1E2D` at 24%. The review page's dark themes use top `#3DB88C`, highlight `#4FC79A`, edge `#237A5C`, eyes `#0B2A20`, bottom `#6B7270`, edge `#4A504E`. One-color icons take the agent color, `#1e8463` light and `#3db88c` dark.

To regenerate `icon.png`, render `icon.svg` at 256 × 256 with a transparent background, for example in headless Chromium through `playwright-core`. Both are drawn from code, with no stock imagery or generated bitmaps.
