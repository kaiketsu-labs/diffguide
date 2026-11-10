# Project instructions

DiffGuide is a VS Code extension for reviewing code with Claude on one review page, for local changes and for GitHub pull requests. Editing and navigation stay in VS Code's editor. Keep the workflow simple and preserve existing behavior.

## Code map

- `src/extension.ts` wires everything together, including the actions the PR review page calls.
- `src/pullRequestOverview.ts` is the PR review page's extension side: its HTML and CSS, and the messages it exchanges with the page. `src/webview/overview.ts` is the page script, bundled for the browser into `dist/overview.js`.
- `src/localReview.ts` feeds the review page in local mode: the workspace repository's changes against HEAD, untracked files, and unchanged files shown whole. `src/localFilesView.ts` is the Local sidebar view.
- `src/reviewedFiles.ts` stores review marks: files ticked Viewed and line ranges marked read.
- `src/unifiedDiff.ts` parses `git diff` into highlighted hunks. `src/anchors.ts` captures and relocates code by content.
- `src/pullRequests.ts` reads and writes PRs through `src/githubApi.ts`, which signs in with VS Code's GitHub account. `src/pullRequestView.ts` is the PR sidebar.

## Code

- Use strict TypeScript with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- Reuse existing helpers. Anchor anything that must follow code across edits with `anchors.ts`, so it lapses instead of moving to unrelated lines.
- Keep persisted review data independent of the transport. Treat transport and webview messages as unknown until validated.
- Add doc comments for exported behavior. Do not number implementation steps in comments.

## Review page webview

- Type both directions of the page protocol with `PageMessage` and `ExtensionMessage`. The extension still validates every page message.
- `frameMain` runs inside the HTML preview frame from its source text, so it must not use anything outside its own body.
- The CSS lives in a template string: no backticks or `${` in it. Its rules sit on long lines; change them with Edit on a unique selector, not scripted rewrites.
- Redraw only what changed. `renderFiles([paths])` rebuilds those files' boxes; `renderFiles('state')` rebuilds files whose state changed. A full `renderFiles()` is for global changes such as layout, and costs about 100 ms on a 40-file PR.
- Update the page right away for the user's own toggles (Viewed, read marks) and let the extension's next state confirm them. A round trip waits for a 150 ms debounce and a state re-read.

## UI

- Webview colors, type sizes, spacing and corners come from `src/designTokens.ts` as CSS custom properties (`--brand`, `--ink`, `--radius-md`). Use only those properties in webview CSS; change a value there, not at the use site. `src/webviewStyles.ts` holds the shared buttons (`primary`, `agent`, `quiet`, `small`), inputs, key caps and chips.
- Color names who is involved: `brand` is you and stays neutral (the theme's text color), `agent` slate is the coding agent and its orb, `github` blue is GitHub. Everything else follows the VS Code theme.
- Page controls use the page's own menus (`.picker`, as on Labels and the Files filter) for choices, not native `<select>` or VS Code quick picks. Text fields keep the shared thin inset focus line from `webviewStyles`.
- Use our own page widgets wherever a page can host them: confirm in place (`askInline` row, or `askInMenu` under a button with no row), edit text in an inline form, pick from a `.picker` menu, report results in the page notice. A button that opens a form becomes that form's confirm button, as Merge does. Use VS Code modals, input boxes, quick picks and toasts only where no page is open, such as the sidebar, editor commands and setup, and for errors that must reach a closed page.
- Draw every new icon ourselves in `src/icons.ts`, following [docs/ICONS.md](docs/ICONS.md): 1.25 px line icons, pixels only for the orb and the DiffGuide mark. Don't copy codicons or other icon sets. Native surfaces use the font `npm run icons` builds from the same file.
- Use clear system sans-serif fonts for extension UI and monospace fonts for code.
- Keep UI copy short, in English, and actions self-explanatory. Leave existing German strings until asked.
- Name controls after existing ones that do the same thing; a checkbox that marks lines reviewed is "Viewed", like the file's.
- Give each action a distinct weight: one filled button per row (`agent` when it sends to the agent, `primary` otherwise), secondary buttons, text-only Cancel. Don't show hints for standard shortcuts such as ⌘/Ctrl+Enter. Put status text left and buttons right, Cancel first and the filled button last. Align controls on one row height.
- Before building a new or rearranged surface, sketch it as a rendered HTML mock in the user's theme colors, not ASCII in chat, and confirm terms with the user; "checkbox", "button" and "window" have been misread before.
- Repository illustrations use a neutral, clean style focused on reviewing code and collaborating with an agent, with concrete code and review examples.

## Product invariants

- Submitted comments are delivered automatically. Unsent keystrokes are not agent instructions.
- Comments are written on the review page, for local changes and PRs, and sent with **Ask** or **Implement**. There is no editor command or native editor comment.
- Explain automatic feedback delivery in plain language. Keep transport names in optional technical details; the hook-based default supports the terminal/gateway workflow while Channels remains an experimental opt-in.
- Voice input uses the user's existing macOS Dictation. Do not add an audio recorder or transcription service unless requested separately.
- Keep conversations anchored to their code. Replies must not silently change targets.
- `ask` and `summarize` request discussion without edits; `implement` requests scoped code changes.
- Publishing a PR's Local thread to GitHub is a separate preview-and-publish action.
- Only the human can resolve a thread. An agent response is not human acceptance.
- Preserve immutable event IDs and original code context across edits and restarts.
- A transport connection is not a delivery acknowledgment.
- Do not silently attach uncertain comments or read marks to another line of code.
- Reply Markdown stays untrusted. Model-provided paths or command arguments cannot select navigation targets.
- Keep connection credentials outside the repository and preserve existing Claude configuration.

## Commands

- `npm ci --ignore-scripts` installs dependencies, `npm run build` bundles, and `npm run package` builds the installable VSIX.
- `npm run typecheck` (under a second) and `npm test` (about 12 s) check types and run the tests. Run them without asking. A project Stop hook runs the type check when a turn changed TypeScript.
- `npm run render` screenshots the review page in the user's theme (the `render` skill). `make install` packages and installs the VSIX (the `install` skill).
- Use Python through `uv run` if a supporting media task requires it.

## Verification

- The user tries changes in the installed extension, not the debug host. Reloading the window loads nothing new until you run `npm run package` and `code --install-extension diffguide-<version>.vsix --force`. An install also swaps `dist/overview.js` under open windows, so pages opened before a reload pair old HTML with the new script and break; after every install, tell the user to reload all windows.
- Before handing over a webview change, run `npm run render` and look at the screenshots of the exact build you install. Add a scene to `test/render/fixtures.ts` when none shows the change. Default colors hide border and contrast problems; the screenshot also catches script errors.
- Measure latency claims on a large sample diff, before and after, instead of estimating.
- Verify user-facing flows with end-to-end clicks in VS Code and controlled agent simulation, including the actual failure scenario. `npm run e2e:docker` runs `scripts/e2e.mjs` in headless VS Code: local review page, comment with Ask, a simulated agent answer through the bridge, Resolve. `npm run e2e` runs it in a visible window. Extend that script for new flows. PR flows against GitHub and authenticated Claude stay manual.
- Distinguish automated logic, process simulation, observed native UI and authenticated Claude evidence. Keep unverified flows pending; do not claim completion from unit tests or a simulated walkthrough alone.

## Tracking

- Record user-visible changes as lines under `## Unreleased` in `CHANGELOG.md`. The release workflow moves them into the release as `### Notes`. Keep installation, publishing, review findings and known limitations current in `README.md` and `docs/`. `CHANGELOG.md` is large; read only its top.
- Commit messages use `<type>(<scope>): <lowercase subject>` with `!` before the colon for breaking changes.
