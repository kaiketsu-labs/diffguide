# Contributing

Start with an [issue](https://github.com/kaiketsu-labs/diffguide/issues/new/choose) describing the user problem and a concrete example. For UX changes, include the intended interaction and keyboard behavior. Existing review findings are tracked in [docs/REVIEW.md](docs/REVIEW.md).

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

`npm run render` screenshots the review page with fixture data in your VS Code theme and reports page script errors; the PNGs land in `.render/`. `npm run e2e:docker` packages the VSIX and drives it in headless VS Code inside Docker, with a simulated agent; `npm run e2e` does the same in a visible window. `make check` runs the type check and tests, and `make install` packages the VSIX and installs it into VS Code. Run `make` for the full list.

The automated tests use isolated storage, local Git repositories, and local hook processes. They do not call an LLM. A successful automated run does not replace a real VS Code + Claude walkthrough.

## Change guidelines

Keep TypeScript strict, reuse existing helpers, and document public behavior. Native VS Code interactions should preserve keyboard access, code context, and the human's control over thread resolution. Add regression coverage for meaningful failures rather than tests that repeat the implementation.

Describe what changes for the user, why it changes, and what was verified. Separate source fixes from runtime verification, and disclose simulated responses in demo material. Do not include tokens, private connection files, or unrelated workspace content.

Use conventional commit messages with a lowercase type and a scope, such as `fix(review): preserve a moved comment` or `feat(claude): reconnect an ended session`. Add `!` before the colon for a breaking change.

CI runs the type check, tests, VSIX packaging and the [pre-commit](https://pre-commit.com) hooks on every pull request and push to `main`. Run `pre-commit install` once to run the same hooks before each commit. PR titles must follow the commit message format, since a squash merge uses the title as the commit subject. The Pre-commit job checks the title on each push; after editing only the title, re-run that job. Dependabot opens weekly update PRs; minor and patch updates merge once checks pass. See [docs/PUBLISHING.md](docs/PUBLISHING.md) for release preparation and Marketplace registration.
