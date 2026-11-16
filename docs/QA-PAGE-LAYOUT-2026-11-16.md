# Page layout mock PR checks

Tested `feat/page-layout` at `b820e29`, with added test automation. The packaged 0.9.0 extension ran in headless VS Code through `npm run e2e:docker`. Each run used an isolated profile, local repository and mock PR #201. No GitHub writes or authenticated Claude runs occurred.

## Results

| Check | Evidence | Result |
| --- | --- | --- |
| Existing local review, mock PR and reload flows | Installed extension, local bridge with simulated agent answers | Passed. |
| Comment, Request changes and Approve | Clicked each verdict and submitted a summary to the mock host | Passed failure handling. The mock rejected submission; each summary survived and submission became available again. Successful GitHub submission remains pending. |
| Discard pending | Injected two pending comments into the page; clicked Discard pending, Cancel, then confirmed | Passed page interaction. The real mock host has no pending review, so confirmation returned idle without discarding anything. GitHub deletion remains pending. |
| Commit picked suggestions | Injected a suggestion and edit permission into the page; added it to the batch and clicked Commit | Passed host permission enforcement. The host rejected the read-only mock PR. No commit or push occurred. |
| Guide order | Injected the existing guide and diff fixtures into the mock PR page | All 78 expected diff lines remained in the DOM. This does not verify guide generation by Claude. |
| Native find in folded lines | Opened Guide order, searched for an unchanged line with Ctrl+F and Enter | Initially failed. Passed after excluding hidden="until-found" from the global display:none rule. Undoing the change reproduced the failure. |
| Claude chip during work and code review | Sent the existing working and review-progress fixtures to the page | Passed. The chip and menu showed work, Stop and review progress. Agent execution was simulated. |
| New-answer count while scrolling | Scrolled to each simulated answer | Passed. The first visible answer reduced the count to one; scrolling to the second cleared it. |
| Open in terminal | Clicked the header action with a temporary simulated Claude executable | Passed. The process received a session ID and ran in PR #201's worktree. Live Claude handoff remains pending. |

`npm run typecheck` passed. The full unit suite passed all 471 tests with loopback access. The first sandboxed unit run could not open the bridge listeners.

The initial QA run completed all four scenarios and exited with one failure: native find in folded lines. The follow-up correction passes all four scenarios. `npm run render -- code-guide` passed in Monokai Pro (Filter Octagon); the screenshot was inspected. Current evidence is in `.render/e2e/pr-guide-find.png` and `.render/e2e/pr-answers-seen.png`.

## CI correction

CI invoked the E2E script directly without preparing its fixture bundle, so it failed before VS Code started. The workflow now runs `node scripts/e2e.mjs --prepare` first. The simulated Claude terminal stays open until VS Code closes, and scenario cleanup returns focus to the sidebar before opening the command palette.

## Test setup

The extra scenario lives in `scripts/e2e.mjs`. It reuses `test/render/fixtures.ts` for controlled page states. The host retains the real mock PR's permissions and pending-review state. The fixture state is reapplied after host refreshes so those refreshes cannot erase a page interaction under test.

The terminal check uses a temporary executable that records its working directory and arguments. This tests terminal process launch, not Claude authentication or conversational continuity.

The E2E commands prepare the fixture bundle on the host before Docker starts because the installed esbuild binary targets macOS. Screenshots are written to `.render/e2e/`.
