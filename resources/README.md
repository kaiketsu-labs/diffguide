# DiffGuide identity

The mark is the DiffGuide orb over a pair of diff lines: a + line and a − line on the orb's own pixel grid. The orb is the companion character; its look is recorded in [docs/design/orb-character.html](../docs/design/orb-character.html).

- `icon.svg`: editable vector source on a paper tile, 256 × 256.
- `icon.png`: 256 × 256 RGBA PNG used by the extension manifest and Marketplace listing.
- `review.svg`: 24 × 24 one-color sidebar icon: a solid pixel orb with eye holes over 1 px + and − lines, drawn on whole pixels so it stays crisp in the activity bar.
- `diffguide-icons-<hash>.woff`: icon font for menus, the sidebar and the status bar, built from `src/icons.ts` by `npm run icons`. See [docs/ICONS.md](../docs/ICONS.md).

Palette: paper tile `#FFFFFF` to `#E3E9EF`, slate `#2F7EA6` with tints for the orb's inner light, grey `#9AA7B3` for the removed line.

Export `icon.svg` at 256 × 256 with transparency to regenerate `icon.png`. Both are drawn from code, with no stock imagery or generated bitmaps. VS Code scales `review.svg` to 16 px in some places, where its pixel edges soften.
