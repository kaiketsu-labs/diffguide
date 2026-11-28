# Contributing

Start with an [issue](https://github.com/kaiketsu-labs/diffguide/issues/new/choose) describing the user problem and a concrete example. For UX changes, include the intended interaction and keyboard behavior.

## Local development

Use Node.js 22+ and install the locked dependencies:

```sh
npm ci --ignore-scripts
```

Build with `npm run build`, then open this folder in VS Code and launch **DiffGuide ausprobieren** from Run and Debug. This opens an extension development host. End users install a VSIX and do not need the development dependencies.

After human approval, run the checks relevant to the change:

```sh
npm run typecheck
npm test
npm run package
```

`npm test -- anchors` runs only the test files whose names contain `anchors`.

`npm run render` screenshots the review page with fixture data in your VS Code theme and reports page script errors; the PNGs land in `.render/`. `npm run e2e:docker` packages the VSIX and drives it in headless VS Code inside Docker, with a simulated agent; `npm run e2e` does the same in a visible window. `make check` runs the type check and tests, and `make install` packages the VSIX and installs it into VS Code. Run `make` for the full list.

### Trying a change in a demo window

`make demo` builds this worktree and opens an isolated VS Code window (own user data in a short temp folder and extensions under `.demo/`; only the extensions of your themes are copied in) on a fixed sample repository with one feature-rich fake pull request: reviewers, checks, comment threads in every state, a Claude guide and two Local threads. Your own `settings.json` and `keybindings.json` are copied in, with `diffGuide.mockPullRequests` on. Ask and Implement use your real Claude Code. Run it in several worktrees at once; each window title names its worktree. Edits to the sample PR stay in memory and reset when the window closes. On macOS the window opens in the background without taking focus, and it opens the demo PR by itself. If the worktree's demo window is already open, `make demo` only rebuilds; reload that window to load the new build. Quit the window to get a fresh repository and profile on the next run. Outside macOS it needs the `code` command on your PATH.

The seed data is `src/forges/demo/fixture.ts` and the repository recipe is `demo/sample-repo/`.

The automated tests use isolated storage, local Git repositories, and local hook processes. They do not call an LLM. A successful automated run does not replace a real VS Code + Claude walkthrough.

## Change guidelines

Keep TypeScript strict, reuse existing helpers, and document public behavior. Native VS Code interactions should preserve keyboard access, code context, and the human's control over thread resolution. Add regression coverage for meaningful failures rather than tests that repeat the implementation.

Describe what changes for the user, why it changes, and what was verified. Separate source fixes from runtime verification, and disclose simulated responses in demo material. Do not include tokens, private connection files, or unrelated workspace content.

Use conventional commit messages with a lowercase type and a scope, such as `fix(review): preserve a moved comment` or `feat(claude): reconnect an ended session`. Add `!` before the colon for a breaking change.

CI runs the type check, tests, VSIX packaging and the [pre-commit](https://pre-commit.com) hooks on every pull request and push to `main`. Run `pre-commit install` once to run the same hooks before each commit. PR titles must follow the commit message format, since a squash merge uses the title as the commit subject. The Pre-commit job checks the title on each push; after editing only the title, re-run that job. Dependabot opens weekly update PRs; minor and patch updates merge once checks pass. See [docs/PUBLISHING.md](docs/PUBLISHING.md) for release preparation and Marketplace registration.
