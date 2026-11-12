# DiffGuide identity

The mark is the DiffGuide orb over a pair of diff lines: a + line and a − line. The orb uses larger pixels than the lines. The orb is the companion character; its look is recorded in [docs/design/orb-character.html](../docs/design/orb-character.html).

- `icon.svg`: editable vector source, 256 × 256. The paper tile fills the whole canvas. The orb is drawn in 13 px cells and the lines are 9 px thick, so every edge lands on a whole pixel. A blurred halo sits behind the orb.
- `icon.png`: 256 × 256 RGBA PNG used by the extension manifest and Marketplace listing.
- `review.svg`: 24 × 24 one-color sidebar icon: a solid pixel orb with eye holes over 1 px + and − lines. The orb uses 1.5 px cells, so it fills the full height and stays sharp on 2x screens; on 1x screens its edges soften.
- `diffguide-icons-<hash>.woff`: icon font for menus, the sidebar and the status bar, built from `src/icons.ts` by `npm run icons`. See [docs/ICONS.md](../docs/ICONS.md).

Palette: paper tile `#FFFFFF` to `#E3E9EF`, slate `#2F7EA6` with tints for the orb's inner light, `#1B4A62` for the rim facing away from the top-left light, white for the highlight, `#7EAFC8` for the halo, grey `#9AA7B3` for the removed line.

Export `icon.svg` at 256 × 256 with transparency to regenerate `icon.png`. Both are drawn from code, with no stock imagery or generated bitmaps. VS Code scales `review.svg` to 16 px in some places, where its pixel edges soften.
