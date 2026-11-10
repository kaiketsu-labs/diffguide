---
name: render
description: Screenshot the DiffGuide review page in the user's VS Code theme and catch page script errors. Use before handing over any webview change (src/webview/, src/pullRequestOverview.ts, src/webviewStyles.ts, src/designTokens.ts, src/icons.ts), or when asked to render, screenshot or check the review page.
---

# Render the review page

`npm run render` builds `dist/`, renders the real page from `overviewHtml` and `dist/overview.js` in headless Chromium, and writes PNGs to `.render/`. It reads the theme from VS Code's `workbench.colorTheme` and the editor font from the user's settings.

```sh
npm run render                       # every scene
npm run render -- files narrow       # some scenes
npm run render -- files --theme "Light Modern"
```

The command prints each PNG path. It exits 1 and lists page errors when the script throws or logs an error. Open the PNGs with Read and look at them; a clean run alone does not prove the change looks right.

`.render/<scene>.posted.json` holds the messages the page posted to the extension, for checking that a click sends the right `PageMessage`.

## Scenes

Scenes live in `test/render/fixtures.ts`, typed against `OverviewState` and `ExtensionMessage`, so the typecheck catches fixtures that drift from the page protocol.

- `overview`, `files`, `guide`: a PR with GitHub details, checks, reviewers, Local threads and an unpushed commit, on each tab.
- `working`: the same PR while Claude runs.
- `narrow`: the Files tab at 420 px.
- `local`: the local review page.

When a change needs a state no scene shows, add a scene there instead of writing a script in `/tmp`. A step can `click` a selector, `scroll` or `scrollTo`, `wait` in ms, and take a `shot`, optionally `full` page. `saved` sets what `getState()` returns, such as `{ view: 'guide' }` or `{ marginThreads: true }`.

## Limits

The page runs outside VS Code: no extension host, no real Claude or GitHub. Messages the page posts are recorded, not answered. This checks layout, colors and script errors, not end-to-end flows.

## End to end in VS Code

`npm run e2e:docker` packages the VSIX and runs `scripts/e2e.mjs` in headless VS Code inside Docker: it opens the local review page in a throwaway profile and repo, comments with Ask, answers as a simulated agent through the extension's bridge, and resolves. Screenshots land in `.render/e2e/`; a failure saves `failure.png` and names the last step that passed. `npm run e2e` runs the same in a visible window, without taking the mouse. Add steps to that script when a change touches a flow it covers.
