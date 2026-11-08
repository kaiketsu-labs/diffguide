# Icons

DiffGuide draws its own icons. Every icon lives in [`src/icons.ts`](../src/icons.ts); don't copy codicons or other icon sets into the extension.

## Style

- 16 × 16 viewBox. Keep shapes inside 1 to 15 so nothing touches the edge.
- Line icons use `line(...)`: 1.25 px strokes, round caps and joins, no fill. Use `solid` only for small dots and the stop square.
- Keep at least 1.5 px between an inner mark and its outline. A `!` or `?` must not touch its triangle or bubble.
- Pixels mean the agent. Only the orb poses and the DiffGuide mark use `pixels(...)`, drawn on whole pixels. No other icon borrows that look.
- Draw in `currentColor`. Color comes from the surrounding CSS (`color:`), never from the icon. Agent slate comes from the agent button or chip.
- Buttons that send to the agent use `agent(...)`: the orb with a line badge for the action, through `agentButton` on the page. Ask is `agentAsk`, Implement `agentImplement`, the Guide `agentGuide`.
- Text buttons get their icon from `labelIcons` in `webview/overview.ts`, keyed by the label's first words. Add a label there when you add a button.
- Name icons after what they mean (`hidden`, `reaction`), not after their shape.

The GitHub mark is the one exception: it is GitHub's logo, kept as GitHub draws it.

## Add an icon

1. Sketch it next to the icons it sits beside, in both themes, at 16 px and zoomed. Confirm it with the user before writing code.
2. Add it to `icons` in `src/icons.ts`, with `line(...)` and the shared parts (`ring`, `bubble`, `tray`) where they fit.
3. Use it in a webview: `icons.<name>` in page HTML (`pullRequestOverview.ts`, `composer.ts`) or `icon(icons.<name>)` in the page script (`webview/overview.ts`). Size it with CSS width and height; 16 px for buttons and tabs, 14 px in dense rows.

## Native VS Code surfaces

Menus, view titles, tree rows and the status bar can't show SVG strings. They use the icon font `resources/diffguide-icons.woff`, built from the same `src/icons.ts`.

1. Add the icon's name to the end of `native` in `scripts/icons.mjs`. Don't reorder the list: each icon keeps its code point.
2. Run `npm run icons`. It needs `uv`. It rebuilds the font and rewrites `contributes.icons` in `package.json`.
3. Refer to it as `$(diffguide-<name>)` in `package.json` and status bar text, or `new vscode.ThemeIcon('diffguide-<name>')` in code. `orbAsleep` becomes `diffguide-orb-asleep`.
4. Commit the font and `package.json` together.

Keep standard VS Code actions on their codicons (`$(refresh)`, `$(search)`, `$(trash)`, `$(git-pull-request)` and the other git states). People know them from the rest of the editor.

## Check

Render the page in headless Chromium with the user's theme colors, as in [AGENTS.md](../AGENTS.md). Look at each new icon at 1× and 2×, in light and dark. For native icons, reload VS Code after installing and look at the menu, tree or status bar itself.
