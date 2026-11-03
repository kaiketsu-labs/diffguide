# Project instructions

Local Review is a VS Code extension for reviewing code with Claude: native inline comments on local changes, and a PR review page for GitHub pull requests. Keep the native VS Code workflow simple and preserve existing behavior.

## Code map

- `src/extension.ts` wires everything together, including the actions the PR review page calls.
- `src/pullRequestOverview.ts` is the PR review page: a webview whose script and CSS live inside one TypeScript template string.
- `src/reviewedFiles.ts` stores per-PR review marks: files ticked Viewed and line ranges marked read.
- `src/unifiedDiff.ts` parses `git diff` into highlighted hunks. `src/anchors.ts` captures and relocates code by content.
- `src/pullRequests.ts` reads and writes PRs through `src/githubApi.ts`, which signs in with VS Code's GitHub account. `src/github.ts` handles PR handoff. `src/pullRequestView.ts` is the PR sidebar.

## Code

- Use strict TypeScript with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- Reuse existing helpers. Anchor anything that must follow code across edits with `anchors.ts`, so it lapses instead of moving to unrelated lines.
- Keep persisted review data independent of the transport. Treat transport and webview messages as unknown until validated.
- Add doc comments for exported behavior. Do not number implementation steps in comments.

## Review page webview

- The script is untyped JavaScript inside a template string, so `tsc` does not check it. Never write backticks or `${` in it, double every regex backslash, and do not shadow its helpers (`range`, `el`, `button`).
- Redraw only what changed. `renderFiles([paths])` rebuilds those files' boxes; `renderFiles('state')` rebuilds files whose state changed. A full `renderFiles()` is for global changes such as layout, and costs about 100 ms on a 40-file PR.
- Update the page right away for the user's own toggles (Viewed, read marks) and let the extension's next state confirm them. A round trip waits for a 150 ms debounce and a state re-read.

## UI

- Use clear system sans-serif fonts for extension UI and monospace fonts for code. Never use Comic Sans or handwritten novelty fonts.
- Keep UI copy short, in English, and actions self-explanatory. Leave existing German strings until asked.
- Name controls after existing ones that do the same thing; a checkbox that marks lines reviewed is "Viewed", like the file's.
- Give each action a distinct weight: one filled primary button in the thread's accent color, bordered secondary buttons, text-only Cancel, keyboard hints as key caps. Align controls on one row height.
- Before building a new or rearranged surface, sketch it and confirm terms with the user; "checkbox", "button" and "window" have been misread before.
- Repository illustrations use a neutral, clean style focused on reviewing code and collaborating with an agent, with concrete code and review examples.

## Product invariants

- Submitted comments are delivered automatically. Unsent keystrokes are not agent instructions.
- Native inline input is the default, with one send action and `/a`, `/i`, `/r` interpreted when sending. The optional compact side composer previews modes while typing.
- Explain automatic feedback delivery in plain language. Keep transport names in optional technical details; the hook-based default supports the terminal/gateway workflow while Channels remains an experimental opt-in.
- Voice input uses the user's existing macOS Dictation. Do not add an audio recorder or transcription service unless requested separately.
- Keep inline conversations anchored to their code. In the side composer, empty drafts may follow new explicit selections; written drafts and replies must not silently change targets.
- `ask` and `summarize` request discussion without edits; `implement` requests scoped code changes.
- `/r` summarizes a local conversation. Publishing to a GitHub PR is a separate preview-and-publish action.
- PR handoff publishes the reviewed snapshot only and does not acknowledge delivery or resolve local threads.
- Only the human can resolve a thread. An agent response is not human acceptance.
- Preserve immutable event IDs and original code context across edits and restarts.
- A transport connection is not a delivery acknowledgment.
- Do not silently attach uncertain comments or read marks to another line of code.
- Code actions open current project code only after a confirmed content match. Proposed, missing or ambiguous snippets stay read-only; Markdown code blocks do not claim native editor semantics.
- Code-reference actions belong in the native comment header, alongside the author, without a separate action row in the body.
- Code examples may intentionally stop at a function header. Display repair must preserve their bytes and surrounding prose without inventing a function body or closing brace.
- Native header actions bind original comment objects to opaque session handles. Model-provided paths or command arguments cannot select navigation targets; reply Markdown stays untrusted.
- Native code cards use only approved theme-aware markup. Neutralize original message HTML before enabling generated HTML; navigation continues reading undecorated stored code.
- Keep connection credentials outside the repository and preserve existing Claude configuration.

## Commands

- `npm ci --ignore-scripts` installs dependencies, `npm run build` bundles, and `npm run package` builds the installable VSIX.
- `npm run typecheck` and `npm test` check types and run the tests. Ask before running lint, type checks or tests in approval-gated sessions. Builds and packaging are separate operations.
- Use Python through `uv run` if a supporting media task requires it.

## Verification

- The user tries changes in the installed extension, not the debug host. Reloading the window loads nothing new until you run `npm run package` and `code --install-extension local-review-<version>.vsix --force`.
- Before handing over a webview change, render the page in headless Chromium with the user's theme colors (VS Code theme keys as `--vscode-*` variables) and look at a screenshot of the exact build you install. Default colors hide border and contrast problems; the screenshot also catches script errors.
- Measure latency claims on a large sample diff, before and after, instead of estimating.
- Verify user-facing flows with end-to-end clicks in VS Code and controlled agent simulation, including the actual failure scenario.
- Distinguish automated logic, process simulation, observed native UI and authenticated Claude evidence. Keep unverified flows pending; do not claim completion from unit tests or a simulated walkthrough alone.

## Tracking

- Record user-visible changes in `CHANGELOG.md`. Keep installation, publishing, review findings and known limitations current in `README.md` and `docs/`.
- Commit messages use `<type>(<scope>): <lowercase subject>` with `!` before the colon for breaking changes.
