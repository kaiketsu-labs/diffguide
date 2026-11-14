---
name: bench
description: Time the DiffGuide review page and PR sidebar on fixed fixtures and compare runs. Use before and after any change meant to make the page, the sidebar, diff reads or syntax colors faster, and before stating any latency number in a commit, PR or chat.
---

# Bench the review page

`npm run bench` times the waits a user sees, on two pinned commit ranges of this repository (`typical`, 34 files; `large`, 235 files) and on the sidebar (9 PRs, 3 checked out). GitHub answers after latencies measured with `gh`, listed in `test/bench/forge.ts` and `test/bench/sidebar.ts`. Each host run is a fresh process, so caches start cold.

```sh
npm run bench -- --label before                  # all fixtures, 7 runs, writes .bench/before.json
npm run bench -- --fixture large --runs 5        # one fixture
npm run bench -- --scale 0                       # GitHub answers at once
npm run bench -- --compare .bench/before.json .bench/after.json
```

`.bench/` is ignored by Git.

## Metrics

- `host.cold.*`: first open of a PR page. `panel` is the page shown, `files` the uncolored files, `firstColors` and `colored` the first and last color batch.
- `host.warm.*`: reopen, with colors known.
- `host.viewed.*`, `host.refresh.*`: ticking Viewed and pressing Refresh.
- `host.commit.*`: unfolding a commit in a thread. `host.analyze.started`: Claude's guide build getting its changes.
- `host.*.git`, `host.*.github`: process and request counts. A change that should cut calls shows here.
- `page.*`: the page script in Chromium, replaying the messages the fixture's host run sent. `files.painted` is the first screen, `files.drawn` all diffs, `longTaskMs` and `longestTask` the main-thread blocks over 50 ms, `nodes` the DOM size.
- `saved.*`, `fresh.*` (sidebar): rows drawn with the last list saved and without.

## Procedure

1. Run a baseline with a label before you change code. Don't compare against an older file from another branch state.
2. Find where the time goes before you pick a fix. Several obvious fixes measured as useless: loading grammars earlier (they load in 46 ms), more than four color workers, trimming GitHub search fields the rows need.
3. Change one thing, run again with the same `--runs`, and `--compare`. Use medians; read p95 for noise.
4. Put the before and after medians, the run count and the fixture in the commit message.
5. Keep timing out of `npm test`. Unit tests for a speedup count states, requests, calls or batches.

## Pitfalls

- The bench can time itself. Handing the page a 3 MB message inside the timed call once counted Playwright's transfer as a 320 ms long task; delivering all color batches in one call overstated long tasks. When a number surprises you, read how `scripts/bench.mjs` measures it first.
- Showing the page earlier opens races. A state arriving during the page's first read once left the page on "Loading changes…" forever. Unit tests missed it; `npm run e2e`, whose mock forge answers at once, failed 2 of 4 runs. After making a wait asynchronous, run the e2e several times.
- The bench runs workers under plain Node. `npm run e2e` checks that they color the local page in VS Code's extension host.
