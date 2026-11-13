# Changelog

## Unreleased

- PR pages open before GitHub sends the description, reviewers and checks. Pulsing bars hold their places, and review and merge wait until GitHub answers.
- A PR's changed files show right away the first time they are read, without syntax colors; the colors follow once they are ready.
- PR pages no longer wait for GitHub's file list. The viewed count pulses until it arrives, and files show once GitHub's Viewed marks are known.
- PR pages no longer wait for linked changes in other repositories. The Linked changes card pulses until GitHub answers.
- Review pages reopen in their tabs after a window reload, instead of closing.
- Refresh on the review page spins while it reloads, then says "Refreshed." or shows why it failed.
- Resolving a thread folds it, also after jumping to it from the code review card.
- PR pages follow the base branch on GitHub: after a retarget, or when the base moves on, the diff matches GitHub's and comments no longer fail with "Filepath must be part of pull request". Refresh checks right away.
- Suggested changes in GitHub comments show as a diff with removed and added lines. Code in GitHub comments and suggestions uses the page's own syntax colors.
- When the base branch moves while Claude works, a notice says the files are out of date and offers Refresh. It stays until the files reload.
- **Finish your review** counts the pending comments it lists.
- In comments and Claude's answers, ```x``` on one line is inline code, no longer an open code block that swallows the rest of the message.

## [0.9.0](https://github.com/kaiketsu-labs/diffguide/compare/v0.8.0...v0.9.0) (2026-11-12)


### Features

* **branding:** new logo, banner and readme ([#69](https://github.com/kaiketsu-labs/diffguide/issues/69)) ([8b3f9c3](https://github.com/kaiketsu-labs/diffguide/commit/8b3f9c33adf8599358eea6551c4295025cb2580c))


### Refactoring

* **src:** layered architecture and split review page script ([#66](https://github.com/kaiketsu-labs/diffguide/issues/66)) ([2429173](https://github.com/kaiketsu-labs/diffguide/commit/2429173a69ba0f423f938ab5ae09da5fa3a6f9a8))
* **src:** split activate() and the pr list into modules ([#68](https://github.com/kaiketsu-labs/diffguide/issues/68)) ([c08cb2c](https://github.com/kaiketsu-labs/diffguide/commit/c08cb2c8f78976747b23db24d9c3ac91ce5ef561))

## [0.8.0](https://github.com/kaiketsu-labs/diffguide/compare/v0.7.0...v0.8.0) (2026-11-11)


### Notes

- Submitting a review on the review page shows it and its comments in the Conversation right away.
- A review made only of line comments shows in the Conversation as "reviewed", with each comment's file, line and text under it. A click jumps to the comment.
- Hovering a comment mark in the diff, a row in the Comments list or a thread row on the Overview shows a preview with the thread's status, place and latest message, instead of a plain tooltip.
- **Finish your review** lists your pending comments by file and line. Click one to jump to it.
- **Re-check findings** on the code review card asks Claude in each open finding's thread whether the current code fixes it, without editing. You resolve the fixed ones.
- **Since your last review** lists the commits it covers, in the range menu, above the files and in the commit facts.
- Ask and Implement work on a GitHub comment whose code changed since. The local thread is about the whole file and quotes the diff the comment was written on.
- **Draft reply** turns back on in an open Reply or Publish form once Claude's run ends.
- In VS Code in a browser, such as on SageMaker, the review page's tab shows its colored PR icon.
- The Pull Requests and Local views show "Building guide" or "Reviewing" while a guide build or code review runs.
- While Claude answers comments, builds the guide or reviews, the PR or Local row and the review page's tab show the orb as their icon, in the agent color `diffGuide.agent`.
- The Pull Requests view colors a checked-out PR by its local state: an orange title and `↑N` badge for commits not pushed to GitHub, a yellow title and `✎` for uncommitted edits only, a gray `W` when nothing is left to push. With both, the edited file count `✎N` shows in the description. A repository row counts its PRs with commits to push. The description keeps the PR number, the author on review requests, Claude while it works or needs you, and review progress; type, size, draft and idle Claude move to the hover text.
- **Review** on the review page runs a code review with Claude's review agents: Correctness, Design, Security, Performance and Tests, picked from the arrow beside the button and remembered per repository. Each agent writes and runs scratch tests in its own worktree, removed when the review ends. Design also looks for simpler structure and proves it with a rewrite that passes the tests. Tests reports a change no test would catch, proven by a new test that fails once the change is broken on purpose. Proven findings, at most 10, open as **Review** threads tagged with their agents, severity and evidence (Tested, Rewritten, Traced or Cited). A summary card above the files lists the findings and every dropped candidate with its reason. Review runs on PRs and on local changes, independent of the guide.
- The review page shows how many tokens a PR's Claude conversation holds after its last run, beside Claude's status. Its menu starts a new conversation or compacts the current one with Claude Code's `/compact`.
- **Draft reply** in a thread's Reply form has Claude write the GitHub comment from what you typed: notes on what to say, or a draft to revise. On a GitHub thread the draft replaces your text; on a Local thread it opens the Publish form, whose own **Draft reply** revises it. A GitHub thread's Reply form now lists Implement before Ask, as a Local thread's does.
- A commit Claude makes for a comment shows under its reply to that comment, not at the end of the thread. Commits recorded before this update still show at the end.
- **Close all** on the review page closes every opened file without a visible comment, including files that only hold hidden guide notes or archived threads. A closed file comes back when you open it again or a comment you can see lands on it.
- The review page's tab shows the PR's icon in its theme color: open, draft, awaiting review, the review verdict, merged or closed. The Pull Requests view draws these icons in DiffGuide's own style.
- With **Collapsed comments in the margin** on, every thread in the diff starts as a mark in the margin. Click a mark to open the thread; collapse it to send it back.
- The commit range menu lists the newest commit first.
- A pinned thread header on the **Overview** tab no longer lets the thread's text show above it.
- **Show earlier messages** centers its icon with its label, and **Hide earlier messages** points its arrows the other way.

### Features

* **claude:** show the conversation's token count with new conversation and compact ([aa9fccf](https://github.com/kaiketsu-labs/diffguide/commit/aa9fccf6a3a8b35e0282e9e409a90de9954b6ca2))
* **pr:** ask about github comments on changed code ([43e6d87](https://github.com/kaiketsu-labs/diffguide/commit/43e6d87ce00505d0466a528c08741b4315805af7))
* **pr:** color pr rows by unpushed commits and uncommitted edits ([c0b2b48](https://github.com/kaiketsu-labs/diffguide/commit/c0b2b48a53274b946103a4a739fc5c6286f3c620))
* **pr:** list the commits since your last review ([27857b5](https://github.com/kaiketsu-labs/diffguide/commit/27857b56616a1d9522cc5e8e530d5a5795ef009f))
* **pr:** show the pr's status icon in the review page's tab ([58e7817](https://github.com/kaiketsu-labs/diffguide/commit/58e781792a502d07df2f838e9975544bb75c93cc))
* **review:** add a code review mode with review agents ([#49](https://github.com/kaiketsu-labs/diffguide/issues/49)) ([eb93c18](https://github.com/kaiketsu-labs/diffguide/commit/eb93c186d765fdd61b3b392c81537ef9b29b1804))
* **review:** list pending comments under finish your review ([47bf87a](https://github.com/kaiketsu-labs/diffguide/commit/47bf87a49397fe9054ac75c4a3fc2c7f2f4c7a1e))
* **review:** re-check open findings against the current code ([39579ed](https://github.com/kaiketsu-labs/diffguide/commit/39579ed738bbe687e436fcb6480b23406e3020bb))
* **sidebar:** show running guide builds and code reviews ([0ab6aa6](https://github.com/kaiketsu-labs/diffguide/commit/0ab6aa6edab568f9bac3e5f9bca5b3787481308d))
* **sidebar:** show the orb as the icon of rows and tabs where claude works ([c6f2926](https://github.com/kaiketsu-labs/diffguide/commit/c6f292673870a9c39bcf13fa9a928249b41589cc))
* **webview:** draft github replies from the reply form's notes ([866d45d](https://github.com/kaiketsu-labs/diffguide/commit/866d45d7e34cc3249955c24b112292b08ce63f08))
* **webview:** preview a comment's latest message on hover ([e41a125](https://github.com/kaiketsu-labs/diffguide/commit/e41a1252a7cb537464cf24862667650f08973267))
* **webview:** show each commit under claude's reply to its comment ([29dc55e](https://github.com/kaiketsu-labs/diffguide/commit/29dc55e6c0c5970b00593b631b64f34d734d4f43))


### Bug Fixes

* **pr:** enable draft reply again once claude finishes ([2348270](https://github.com/kaiketsu-labs/diffguide/commit/23482703a079b3238bfed7371a4025eeeae6e533))
* **review:** show a submitted review in the conversation ([3b29670](https://github.com/kaiketsu-labs/diffguide/commit/3b29670568b94b8ed29594f1e7bd580f24553079))
* **review:** show comment-only reviews in the conversation ([4627040](https://github.com/kaiketsu-labs/diffguide/commit/46270405d0b613ee6c9baeb8e5089212c5e2b5d8))
* **webview:** keep closed files closed when they hold only hidden threads ([2e3df1e](https://github.com/kaiketsu-labs/diffguide/commit/2e3df1ef18c201647b2ad8307bea855c4ac950ed))
* **webview:** show colored tab icons in browser vs code ([59951ba](https://github.com/kaiketsu-labs/diffguide/commit/59951ba45ce0ec1dd94223046811c7ee5c8a702f))
* **webview:** tidy margin comments, earlier messages and the commit menu ([a95a36b](https://github.com/kaiketsu-labs/diffguide/commit/a95a36bebff329967cd6d5a5ba3f151a09faf613))

## [0.7.0](https://github.com/kaiketsu-labs/diffguide/compare/v0.6.0...v0.7.0) (2026-11-10)


### Notes

- **All open** in the Pull Requests view shows how many PRs are open. The count can be higher than the rows, which stop at 50.
- Requesting, removing or re-requesting a reviewer on the review page refreshes the Pull Requests view.
- A reviewer who only left a comment stays in the reviewer list with **Re-request review**. A re-requested reviewer reads "Approved · Re-requested" (or their earlier verdict), is ticked in the Reviewers menu, and loses the button until they review again.
- **Show on review page** in the Explorer's context menu is now **Show in DiffGuide**.
- Tables in the PR description have borders, and Markdown tables in comments render without outer pipes too. The description shows at full length instead of scrolling in its own box.
- Inline code in comments, replies, the description and Markdown previews takes the theme's ANSI cyan, overridable as `diffGuide.inlineCodeForeground`.
- A merged or closed PR shows **Merged** or **Closed** at the top of the review page.
- PDF and HTML previews keep a fixed height and scroll inside.
- The orb reacts in step logs. It wakes when a run starts, dozes off and sleeps on a comment that waits while Claude is not receiving comments, nods once Claude picks the comment up, and leads the way while the guide is built. With reduced motion it shows where each reaction ends.
- The thinking orb changes what it does every 6 seconds: it circles sparks, ponders a "?", juggles, shows typing dots, sends out ripples, rolls its eyes or hops.
- ⌘/Ctrl+F opens VS Code's find bar on the review page. It finds text on the page only, so folded files and hunks and PDF pages are not searched.
- Each comment you send shows whether it went with **Ask** or **Implement**.
- **Stop** sits next to the running step's time, in threads and while the guide builds.
- A thread's **Stop** stops the run and takes your last comment back into its box to edit and send again. The page says whether Claude had already read it. On local review pages Stop only takes the comment back, since your own Claude session answers there. Stop shows the run as ended without waiting for GitHub.
- While the guide builds, the **Guide** tab's icon moves. When the guide is out of date, the tab shows a warning mark.
- The orb stretches in flight before it lands in a reply.
- Messages in a thread sit in their own cards, set apart from each other.
- A comment on a whole file can go to GitHub, and whole-file threads from GitHub show as **Whole file**.
- **Ask the agent about this comment** on a Conversation comment starts a local thread about the whole PR. It quotes the comment, shows under it and in the Threads card, and can be published as a PR comment.
- Guide comments show in the **Guide** tab only. **Show guide comments** in the **View** menu brings them back to **Files** and its **Comments** panel.
- The file list highlights the file at the top of the view and scrolls to keep it visible. Drag its edge to resize it; double-click resets.
- A **Comments** panel under the file list lists open threads by file and reaches the bottom of the window. Click one to jump to it. Drag the line above it to resize it. It scrolls up and down only.
- The Files filter menu opens above sticky thread headers.
- An HTML file whose content is drawn by scripts can show it on the review page: **Run scripts** in the preview's note row runs the file's scripts in the sandboxed frame. The page's buttons and links then work, and clicks elsewhere start a comment. A comment on drawn content attaches to its nearest element in the source. **Stop scripts** goes back to the static page.
- In VS Code for the Web, ⌘/Ctrl+J and ⌘/Ctrl+Shift+J on DiffGuide's pages run your VS Code shortcuts again instead of opening the browser's Downloads or DevTools. This covers the review page, **Publish** and **Connect running Claude**. Other extensions' pages and VS Code's own previews still pass these keys to the browser.
- Fixed: a loaded HTML preview no longer disappears when another file on the page redraws, such as a PDF finishing loading or ticking another file Viewed.

### Features

* **files:** show guide comments only in the guide unless the filter menu turns them on ([8d42ade](https://github.com/kaiketsu-labs/diffguide/commit/8d42ade16c1be3985b008b887cd97d6ed487c7e7))
* **guide:** animate the guide tab's icon while the guide builds ([c02f204](https://github.com/kaiketsu-labs/diffguide/commit/c02f204b17d26547a282111365ca028a08d8ecd5))
* **guide:** mark the guide tab when the guide is out of date ([70606ba](https://github.com/kaiketsu-labs/diffguide/commit/70606ba81b521af85afe6b90424b732d98aafb65))
* **overview:** search the review page with ctrl/cmd+f ([d901fc0](https://github.com/kaiketsu-labs/diffguide/commit/d901fc0609497b431efacc1b2d428b45b8584e9c))
* **overview:** show merged or closed in the page header ([9da6b64](https://github.com/kaiketsu-labs/diffguide/commit/9da6b64bdef65e526465e09cf41eff0a57d81c92))
* **preview:** run an html file's scripts on request ([063dc28](https://github.com/kaiketsu-labs/diffguide/commit/063dc2818d250b5c49fe34fa27840167c7aa01b6))
* **preview:** scroll pdf and html previews inside a fixed-height box ([6f659b8](https://github.com/kaiketsu-labs/diffguide/commit/6f659b8000fd3af2f89965ba7adee1161686c57f))
* **review:** merge stop and stop and edit into one stop button ([24c86e2](https://github.com/kaiketsu-labs/diffguide/commit/24c86e2c8230653e6961fa04aa2f21120ba583ea))
* **review:** show whether a comment was sent with ask or implement ([9476deb](https://github.com/kaiketsu-labs/diffguide/commit/9476deba7404b0e3405b8141ea2cb36224efb85b))
* **review:** stop and take back a sent comment to edit it ([befbdce](https://github.com/kaiketsu-labs/diffguide/commit/befbdced2c12dfb6abcbc0a88a6e5d6b63deb9f0))
* **sidebar:** show the open pr count on all open ([8b48c4e](https://github.com/kaiketsu-labs/diffguide/commit/8b48c4e2c637a6eb802b8739a86eb401e9afd770))
* **threads:** ask the agent about a conversation comment in a pr-level local thread ([1a92031](https://github.com/kaiketsu-labs/diffguide/commit/1a92031855d78da262b6e3ecd74fd84c188500e7))
* **threads:** comment on a whole file on github and show github's whole-file threads ([ed677c0](https://github.com/kaiketsu-labs/diffguide/commit/ed677c069700399932e5915e053b02d0c6f4e3fe))
* **webview:** color inline code in markdown ([418906c](https://github.com/kaiketsu-labs/diffguide/commit/418906cc9c524b66f82677c5cc82e7cab7c7bf64))
* **webview:** keep the current file's row in view in the file list ([062c04f](https://github.com/kaiketsu-labs/diffguide/commit/062c04f943de04552df7276405c26aba95016d6e))
* **webview:** let the orb wake, nod, doze, sleep and lead in step logs ([12a2e58](https://github.com/kaiketsu-labs/diffguide/commit/12a2e588165560a7c2218221941f9f8c5ee08744))
* **webview:** list open comments under the file list ([4dbeb97](https://github.com/kaiketsu-labs/diffguide/commit/4dbeb97d6a3aaf10843ddd6686cc362939fffeba))
* **webview:** move show guide comments to the view menu ([07945eb](https://github.com/kaiketsu-labs/diffguide/commit/07945ebf73b03f08194a0d1dd20c02f1c5ae2650))
* **webview:** resize the file list by dragging its edge ([90ed7b7](https://github.com/kaiketsu-labs/diffguide/commit/90ed7b7edb3f8a8dee45a7975e05e78a2056f5b3))
* **webview:** rotate the thinking orb through seven motions ([bf99cd7](https://github.com/kaiketsu-labs/diffguide/commit/bf99cd7259aa4955d3c4dd508ff20250106c6eee))


### Bug Fixes

* **files:** open the filter menu above sticky thread headers ([21d7270](https://github.com/kaiketsu-labs/diffguide/commit/21d72701c757e4fe6a60e03072c666cd30395b62))
* **guide:** style the stale guide's rebuild button as an agent action ([25ce55d](https://github.com/kaiketsu-labs/diffguide/commit/25ce55d059e56ccac464036ac43b2b196c846086))
* **local:** hide a thread's stop when there is no comment to take back ([372664b](https://github.com/kaiketsu-labs/diffguide/commit/372664bc6f831de495a418d5a703421a4498e4b7))
* **markdown:** render gfm tables without outer pipes ([a8b1fd2](https://github.com/kaiketsu-labs/diffguide/commit/a8b1fd287bb11b99ce023166a52305bb11ad9447))
* **orb:** stretch the orb in flight before it lands in the reply ([d672bc2](https://github.com/kaiketsu-labs/diffguide/commit/d672bc242df5573b12e586e5faec424d390261e4))
* **overview:** show the full pr description without a scrollbar ([c22d2f8](https://github.com/kaiketsu-labs/diffguide/commit/c22d2f82e87cf94ba91dde117a60a159343d3403))
* **overview:** style tables in the pr description ([d7af95b](https://github.com/kaiketsu-labs/diffguide/commit/d7af95bd6a835887a8a82d8e5e2956ab543df0a9))
* **review:** keep reviewers who only commented in the reviewer list ([19e1b8c](https://github.com/kaiketsu-labs/diffguide/commit/19e1b8c262262410b3014051e2a9408359c68314))
* **review:** mark re-requested reviewers and tick them in the picker ([a1fb968](https://github.com/kaiketsu-labs/diffguide/commit/a1fb96889d0baa64e058dd1a8f32eb9340d71c8d))
* **review:** put stop beside the running step's time ([074beeb](https://github.com/kaiketsu-labs/diffguide/commit/074beeb3dbc9057110919f67ee72f0065b23f7e5))
* **sidebar:** refresh pr rows after reviewer changes ([35cafc2](https://github.com/kaiketsu-labs/diffguide/commit/35cafc2e0db318a58ff0d34ed24dadb588dde661))
* **webview:** color inline code with the theme's ansi cyan ([fd90a58](https://github.com/kaiketsu-labs/diffguide/commit/fd90a58644ad14666e37e9527e21c1a10fd7c0d3))
* **webview:** keep cmd/ctrl+j for vs code on diffguide pages ([0cef2f7](https://github.com/kaiketsu-labs/diffguide/commit/0cef2f75561db9fe2a052f4917932ebaf5f86721))
* **webview:** keep html previews of files that are not redrawn ([2727eac](https://github.com/kaiketsu-labs/diffguide/commit/2727eac3468dd0ba13b2fc2e1f2d071939abf574))
* **webview:** let the comments panel fill the file column to the bottom ([cb81347](https://github.com/kaiketsu-labs/diffguide/commit/cb81347462a667d22b91ad5830c54ba65d097e43))
* **webview:** space a pr-level thread from its comment's reactions ([69d1bdc](https://github.com/kaiketsu-labs/diffguide/commit/69d1bdcc4672690157a0a5af840706019815e338))
* **webview:** tidy the comments panel and the guide's stop button ([4778bd2](https://github.com/kaiketsu-labs/diffguide/commit/4778bd2ad8b73d59fe7a6ac52194525d58aab755))


### Performance Improvements

* **claude:** show a stopped run as ended without waiting for github ([b461ec4](https://github.com/kaiketsu-labs/diffguide/commit/b461ec473d0e7bb96852c444e334e55e67c2e8f0))

## [0.6.0](https://github.com/kaiketsu-labs/diffguide/compare/v0.5.1...v0.6.0) (2026-11-08)


### Notes

- The **Overview** tab has an icon, like **Files** and **Guide**.
- All UI text is in English. Connection prompts, error messages, settings descriptions, the **How it works** and **Dictation** guides and the flow diagram were still German.
- The **Local** view uses the same purple repository icon as **Pull Requests**. Its title bar drops the connect buttons, since the review page has them. **Review local changes** sits on each checkout row, and in the title bar only when there is a single checkout.
- The **Local** view lists checkouts only, each with how many files changed and how many comments are open. Clicking a checkout opens its review page. **Show on review page** in the Explorer's context menu shows any file of a listed checkout there.
- The file list on the review page collapses with the icon before the tabs, so the files get the full width; each page remembers it. The icon keeps its place on **Overview**, so the tabs no longer shift when you switch. File search and the filter menu sit above the list. A dot on the icon shows that a filter still applies while the list is collapsed.
- The review page has no file tabs. Files you open without changes sit in an **Opened** group at the top of the file list. × on the row or the file's header closes one, and **Close all** closes every one without comments. **All files** in the **View** menu lists the whole repository below that group, with unchanged files dimmed and a dot on folders that hold changes. It is on by default on local pages and off on PR pages, and each page remembers it.
- The file list on PR and local pages shows each file's icon from your file icon theme, with the Git letter after the comment count.
- The **Connect Claude** menu fits its content and gives each choice an icon and a one-line hint. **Connect running Claude** sits apart, under **Claude already running**.
- Removed: the **Review** status bar item that showed the local connection. The status bar still shows Claude's state while a PR worktree file is open.
- Local changes have their own review page. **Review local changes** in the new **Local** view shows your uncommitted changes and new files against HEAD with the same comment boxes, threads, Viewed marks and definition peeks as a PR. Comments still go to the Claude session you connected, and its replies appear in the thread. The page reads the files again when they change on disk.
- The **Local** view replaces the **Review** view. It lists the repository's files with Git's change marks and each file's open comments. Clicking a file shows it on the review page. A file without changes opens whole in its own tab next to **Changes**, with its icon from your file icon theme and one column of line numbers, until you close the tab or while it has open threads.
- Removed: native inline comments in the editor, the **⌘⌥M / Ctrl+Alt+M** shortcut and the editor's comment command, the side composer and its drafts, the editor's orb avatar, the `/a`, `/i` and `/r` prefixes, the Review view with its contrast and centered-layout actions, **Änderungen reviewen**, and the **An GitHub-PR übergeben** handoff. Comment on the review page by clicking a line number, and use **Ask** and **Implement** there. Existing local threads appear on the review page.
- The **Local** view lists every checkout when there is more than one: the window's folders, repositories nested in them, their Git worktrees (such as Claude Code's under `.claude/worktrees`) and the worktrees of PRs you opened. Checkouts sit under one row per repository, which shows how many there are: opened folders first, then worktrees by branch, then PRs by number. The filter button in the view's title bar keeps checkouts whose repository, branch, or PR number or title contains your text; the view remembers it per workspace. **Review local changes** on a row opens that checkout's own review page tab, with its own comments, Viewed marks and Claude connection, so you can review several branches side by side. Clicking a file of a PR worktree opens it on that PR's review page, whole in its own tab when the PR does not change it.
- When the branch of a local review page has an open PR of yours, a **PR #N** chip appears next to the branch. Clicking it turns the same tab into the PR's review page on your own checkout, without a separate worktree: your threads and Viewed marks stay, and comments keep going to the Claude conversation you connected. The checkout never moves on its own there. When GitHub has newer commits, the page says to pull them; **Commit suggestion** makes a local commit for **Push** instead of pushing right away; **Fix conflicts** and **Remove worktree** are left out, so ask your conversation to fix conflicts.
- Opening a file on the review page is faster. DiffGuide keeps the colored code of files it already showed, so opening another file no longer colors every changed file again: on a 23-file change it took about 1.2 s each time and now takes about 0.1 s after the first.
- **Connect Claude** on the local review page opens a menu on the page instead of VS Code pickers: **New conversation**, **Resume a conversation…** with a searchable list of this folder's conversations, **Connect running Claude** with the two commands to run and copy buttons, and **Copy command**. Once connected, the button reads **Open in terminal** and the menu shows the terminal or switches conversations.
- The local review page uses the same **Overview**, **Files** and **Guide** tabs as a PR page. Its Overview shows only Threads, its Files tab is called **Changes**, and Guide is hidden. File tabs follow Guide in the tab bar, and the file tree lists the files of the open tab.
- On a PR's review page, a file outside the diff that has open Local threads gets its own tab, like an unchanged local file, so its threads show on the page. Opening a resolved one from **Threads** adds its tab. If a later commit deleted the file, the tab shows the code saved with its threads, marked **Saved code**.
- DiffGuide draws its own icons. The review page and side composer use thin line icons instead of codicons, and agent buttons lead with the orb. Guide shows the orb with a signpost, and the Files tab, Open in terminal and the composer modes get icons. In the Pull Requests view, Review requested is an inbox, Mine an outbox, All open a stack, repositories a folder with code, and Pinned a bookmark. Open review page shows the DiffGuide mark, and Show Claude activity the orb. The status bar orb is awake when connected, asleep while delivery is paused, and hollow when not connected. Every button on the review page carries an icon, and the idle agent chip shows the orb. Buttons that send to the agent show the orb with a badge, ? for Ask and </> for Implement, in slate: filled for the row's main action, outlined otherwise. **Fix conflicts** is slate too. GitHub thread actions read **Publish**, **Reply** and **Open**, with the GitHub mark. The Pull Requests view draws search, filter and refresh in the same style. **Pinned** is now **Bookmarks**, with **Bookmark** and **Remove bookmark**; your bookmarks carry over. Files in the file tree line up with folders at the same depth. Guide sections in the outline fold and unfold with their chevron. The View and filter menus no longer slide under folder headers. GitHub threads open on GitHub from the icon in their header, and the thread header stays above comments, avatars and Pending chips as they scroll under it. Finish your review shows "N pending comments" as a chip instead of a sentence; "This is your PR" moved into the Comment button's tooltip, and what Fix conflicts does into its own. Conflicts show in the Merge checklist. The composer shows a **Review in progress** chip instead of a hint. **Convert to draft**, **Publish suggestion**, **Restore branch** and **Revert** have icons. File headers are calmer: Full file, Comment on the whole file and Open in editor are icon buttons with tooltips, the comment count is a bubble with a number, and **Viewed** sits last. The tab bar no longer repeats the viewed count; the file tree and guide outline show it, and the file tree says "N of M files" while a filter hides some. With one commit picked, the range button shows its hash only, so the toolbar stays on one row; the title is in the tooltip and the note below.
- The Files toolbar is shorter. **Hide whitespace changes**, **Group files by folder**, **Collapse all comments** and **Collapsed comments in the margin** moved into a **View** menu, and one button collapses or expands all files. The toolbar fits on one row from about 1000px wide.
- The review page has three tabs under its header: **Overview**, **Files** and **Guide**. Overview holds the description, threads, conversation and the side column; Files and Guide show only the changes, so they no longer sit below everything else. The tab bar stays at the top while you scroll. **Finish review** in the tab bar opens Overview at the review box, with a count of your pending comments. In the side column, Finish your review and Merge come first.
- The review page's Files tab has a file tree beside the diffs. Each file shows its change letter, open comments and a tick once Viewed, and clicking it opens the file and scrolls to it. The file at the top of the view is highlighted. Below 1000px the tree folds to a "N files" row above the diffs. The Guide tab lists its sections there instead: each with its severity color and viewed count, then its numbered steps with a tick once Viewed. Clicking a section or step scrolls to it.
- The Pull Requests view lists only PRs. Files and guide steps no longer appear under a PR, so **View as tree**, **View as list**, **Show guide steps under PRs**, **Show files under PRs** and **Mark section read** are gone. Click a PR to open its review page. PR rows still show their reviewed count and ↑/✎ for local work.
- **Pair Review is now DiffGuide.** The extension ID is `kaiketsu-labs.diffguide` and the repository is `kaiketsu-labs/diffguide`. Uninstall Pair Review and install DiffGuide; VS Code does not move you over.
  - Settings and commands moved from `pairReview.*` to `diffGuide.*`. Rename your settings and keybindings by hand.
  - Side-composer drafts, comment window contrast, pinned and hidden PRs, and seen Claude answers start fresh. Local review threads in plain workspaces start empty.
  - PR worktrees move from `.claude/worktrees/pair-review/` to `.claude/worktrees/diffguide/`, with their threads, the first time you open each PR.
  - DiffGuide updates the handoff comments Pair Review posted on GitHub.
  - The Claude command is `/diffguide:connect`. Setup removes the old Pair Review plugin.
- Agent actions no longer name Claude. **Ask Claude** is now **Ask**, the fields read "Ask about these lines" and "Reply", the stop button reads "Stop", and tooltips say "Agent". Agent buttons, chips, threads and guide notes use the orb's slate instead of clay.
- The DiffGuide orb replaces Clawd as Claude's companion. It is Claude's avatar on the review page and in the editor's comment threads. While Claude works, it moves in the step log by what Claude does: it searches while Claude reads or searches, writes along a line while Claude edits, and thinks otherwise. The working chips and the Guide tab's count show it floating and looking around. When Claude's reply replaces the live log, the orb flies from the log into the reply's avatar. With reduced motion it stays still.
- A guide built for an older commit says so at the top of the Guide: which commit it was built for, how many commits it is behind, how many steps no longer match, and how many changes fell into **Not placed by the guide**. **Rebuild guide** sits on that row.
- When Claude answers a Local thread opened from a GitHub comment, it also proposes a reply for the GitHub thread. **Reply on GitHub…** starts from that reply instead of Claude's whole answer, and falls back to the answer when Claude gave none.
- The margin button in the review page's toolbar moves collapsed comments out of the diff. Each shows as a dot beside its line number, and clicking the dot opens the thread in place. Collapsing a thread puts it back into the margin.
- Files with work GitHub does not have are marked on the review page: ↑ for unpushed commits, ✎ for uncommitted edits. Folders on the page carry the mark of their files, and PR rows count the unpushed commits and edited files.
- The new **Claude Answers** view lists Claude's latest answer in each open thread across your checked-out PRs, newest first. Answers you have not seen yet are highlighted and counted on the view, and a row opens its thread on the PR's review page. On the review page, a box in the bottom right lists new answers above or below what you are reading; an answer counts as seen once it scrolls into view.
- The review page has a **Linked changes** card for PRs and branches in other repositories that this PR goes with. Each row shows the linked PR's state (open, draft, merged or closed, checks and review) or "No PR" with the branch, and how many of Claude's commits there are not pushed. **Open review** opens the linked PR's own review page, **Push N commits** pushes Claude's commits to the linked PR, and **Push and open draft PR** pushes a new branch and opens a draft PR that mentions this one.
- PRs link when either PR mentions the other on GitHub, when the diff pins a dependency to another repository's branch (such as `git+https://github.com/acme/api.git@feat/retry` in `pyproject.toml`, `github:acme/ui#feat/retry` in `package.json`, or `branch = "feat/retry"` in `Cargo.toml`), when Claude works in that repository, or with **Link a PR…**. **Unlink** hides a row until you link it again.
- Claude reads another repository at the version this PR goes with. Before reading or changing one, it asks DiffGuide with the new `use_linked_repository` tool. A read gets the linked PR's worktree, brought to its latest commit unless another Claude run is working in it. Without a linked PR, a read gets a worktree on the branch this PR pins, and with no link at all, your own checkout with a note naming its branch. An edit gets the linked PR's worktree, or a new branch named after this PR's head branch. On someone else's PR Claude proposes changes for other repositories instead of making them. Claude's file edits in your repositories outside DiffGuide worktrees are refused; shell commands are not covered by that check. Your own checkouts stay as they are. A branch checked out in your own checkout is read from a detached worktree, and Claude can't edit it until you switch away from it.
- Only one Claude run works in a worktree at a time, also across VS Code windows. A second run shows "Waiting for owner/repo#N" and continues when the first ends; **Stop** works while it waits.
- When a Claude run ends, the Files tab reloads its changes, so **All changes** includes the commits Claude just made. It used to keep showing the changes from before the run until the next check, which skips while Claude works.
- An HTML preview keeps its page while Claude works, threads change or you comment. It used to reload with each of these.
- The stop icon and **Stop and open in terminal** in Claude's step log line up with its first step.
- Clawd in a message avatar no longer draws over a file's sticky header while you scroll.
- A Local thread's reply posted with **Reply on GitHub…** or **Publish to GitHub…** shows up in its GitHub thread right away. It used to appear only after the page next reloaded GitHub's threads, such as when you toggled the thread.
- **DiffGuide: Open PR in DiffGuide** opens a PR's review page from a pasted GitHub link, such as `https://github.com/owner/repo/pull/57/files#discussion_r1`, or from `owner/repo#57`. It uses the workspace folder that holds that repository, and says which repository is missing when no folder has it.
- Claude's avatar is Clawd on a clay-tinted circle on the review page. When Claude's reply replaces its live log, Clawd hops from the log up into the reply's avatar; with reduced motion on, the reply just appears.
- When VS Code has no GitHub sign-in for a host, DiffGuide uses GitHub CLI's token for it (`gh auth token --hostname <host>`). GitHub Enterprise users signed in to `gh` no longer sign in again after each window reload.
- On someone else's PR, Claude also answers Local threads in auto mode, so it can run commands and try a change to test an idea. After each answer, DiffGuide discards its edits and commits, unless the worktree already had uncommitted changes. Git hooks, and the checkout's `CLAUDE.md`, skills, hooks, settings and MCP servers, stay off. Commands that run tests or builds still run the PR author's code.
- Definitions in the same file are found without a language extension's answer. DiffGuide first asks the file's symbols, then looks for a declaration of the name (`def`, `class`, `function`, `const` and similar). The definition panel marks such a match as "same name in this file".
- PR worktrees moved from `.git/pair-review` to `.claude/worktrees/diffguide` in the repository, where Claude Code keeps its own. Claude refused to edit files under `.git` as sensitive, so implementing a comment in a PR worktree failed. Existing worktrees move on the next start, with their uncommitted changes, comments and review marks; Claude starts a new conversation for each. Git ignores the folder through `.git/info/exclude`, so `.gitignore` stays untouched.
- DiffGuide removes PR worktrees when the PR is merged or closed, or when you have not opened it for 14 days (`diffGuide.worktreeCleanupDays`). Worktrees with uncommitted changes or unpushed commits are kept. **DiffGuide: Clean up worktrees** runs the check on demand.
- The review page shows the description, reviewers and checks again. GitHub refused that request because reading team reviewer names needs the `read:org` scope. DiffGuide now asks for it, so VS Code asks you to sign in to GitHub once more.
- New look across DiffGuide's webviews. One set of design tokens in `src/designTokens.ts` sets every color, font size, spacing step and corner radius. Surfaces, text and borders follow your VS Code theme. Your own actions (primary buttons, selections, review progress) use the theme's text color, so only Claude (clay) and GitHub (slate blue) carry a color. The pinned code selection in the editor is neutral too. Corners follow VS Code's modern UI.
- New icon for the activity bar and the Marketplace: the DiffGuide orb over a + line and a − line, drawn in pixels.
- Add your own instructions for the guide (`guide.md`) and for Claude's work on review comments, answers and changes (`comments.md`) in `.claude/diffguide/` folders: in Claude's config folder, parent folders of the project, the repository, or Claude's per-project folder. Claude gets them after the built-in instructions, most specific last. On someone else's PR, the repository's file is read from the base branch. See [Usage](docs/USAGE.md#your-own-instructions-for-claude).
- DiffGuide no longer needs the GitHub CLI. The PR sidebar, review page and PR handoff sign in with your GitHub account in VS Code. When you are signed out, the Pull Requests view shows a **Sign in to GitHub** button (also **DiffGuide: Sign in to GitHub** in the Command Palette), and PR handoff asks you to sign in. The sidebar reloads after sign-in. GitHub Enterprise works for the one host set in `github-enterprise.uri`.
- The PR sidebar fills as soon as it opens: DiffGuide starts when the view is shown, registers the view before its other setup, and finds nested repositories by scanning the workspace folder (honoring `git.repositoryScanMaxDepth` and `git.repositoryScanIgnoredFolders`) instead of waiting for the Git extension's scan.

### ⚠ BREAKING CHANGES

* **local:** removes native inline comments, the side composer, the /a /i /r prefixes, Ctrl+Alt+M, the Review view with its appearance actions, and the PR handoff.
* **pr:** move files and guide outline from the sidebar to the review page
* VS Code installs DiffGuide as a new extension. Settings, keybindings and theme color overrides must be renamed by hand, and workspace data such as drafts, pins and local threads in plain workspaces does not carry over.

### Features

* **local:** review local changes on the review page ([#26](https://github.com/kaiketsu-labs/diffguide/issues/26)) ([55ab1b6](https://github.com/kaiketsu-labs/diffguide/commit/55ab1b67fce07476608afb3d4d8a3134dc5e1026))
* **pr:** flag outdated guides, suggest github replies and list claude's answers ([#39](https://github.com/kaiketsu-labs/diffguide/issues/39)) ([299fd51](https://github.com/kaiketsu-labs/diffguide/commit/299fd511a7a9bfa0b08bfb8f70124964ed2d2adf))
* **pr:** link prs in other repositories and give claude their worktrees ([b1d8bae](https://github.com/kaiketsu-labs/diffguide/commit/b1d8baee13e96290745e1a7add1f3720975ae19c))
* **pr:** move files and guide outline from the sidebar to the review page ([07a8e0c](https://github.com/kaiketsu-labs/diffguide/commit/07a8e0c58f68d51e2a63121cc1fa71c73dac7894))
* **pr:** name agent actions without claude and color them slate ([442933c](https://github.com/kaiketsu-labs/diffguide/commit/442933c6658d40aeeff48ae891d36017f9de97b8))
* **pr:** replace clawd with the diffguide orb ([#43](https://github.com/kaiketsu-labs/diffguide/issues/43)) ([edd5df0](https://github.com/kaiketsu-labs/diffguide/commit/edd5df00b304127828c362a9365caeabaa70b79d))
* rebrand pair review to diffguide ([#41](https://github.com/kaiketsu-labs/diffguide/issues/41)) ([693ec75](https://github.com/kaiketsu-labs/diffguide/commit/693ec754d584dcae52ea0718ebdbe922671213a8))
* **ui:** draw diffguide's own icons ([c7c8f2f](https://github.com/kaiketsu-labs/diffguide/commit/c7c8f2ff3528334c67fbedeb24bc28fab29579c4))


### Bug Fixes

* **pr:** keep the review page current and steady while claude works ([c52fa66](https://github.com/kaiketsu-labs/diffguide/commit/c52fa66a55b274bfac2432090301488c8deeb6c3))

## [0.5.1](https://github.com/kaiketsu-labs/pair-review/compare/v0.5.0...v0.5.1) (2026-11-06)


### Bug Fixes

* **ci:** bump @vscode/vsce to 4.1.0 for marketplace oidc token exchange ([#34](https://github.com/kaiketsu-labs/pair-review/issues/34)) ([1c57e34](https://github.com/kaiketsu-labs/pair-review/commit/1c57e3493c0532d1d2d416d7e784971fad0aa4ac))

## [0.5.0](https://github.com/kaiketsu-labs/pair-review/compare/v0.4.12...v0.5.0) (2026-11-06)


### Notes

- Stopping Claude ends the whole run, including the tools and MCP servers it started. A `claude` shell function in your shell setup kept Claude running after a stop before.
- A thread whose Claude run you stopped reads **Stopped** instead of staying on "Claude is working", and **Retry** sends it to Claude again, also when Claude had already picked it up.
- After you resolve or reopen a GitHub thread, close or reopen the PR, convert it to draft, mark it ready or edit its title, the review page keeps showing your change. GitHub can answer with the old state for a few seconds after a change, and the page used to jump back to it and later forward again. The page checks again until GitHub reports the change, for up to 30 seconds.
- The review page and the Pull Requests view show a new PR title after Claude changes it, or after someone edits it on GitHub. The page's tab title follows. The page reloads the PR from GitHub each time a Claude run ends.
- Refreshing the Pull Requests view no longer pushes the rows down with an "Updating pull requests..." message; it shows only while the list loads for the first time. Rows keep their place and expansion across reloads.
- Opening a PR retries for a moment when macOS reports a transient file system error (`EIO` or `EBUSY`) creating its review data folder, which can happen in folders that iCloud syncs. If it keeps failing, the error names the folder and what to try.
- PR rows in the Pull Requests view have **Copy Link** in their context menu.
- Your own PRs with pending review requests show a yellow eye and **Awaiting review**, with the requested people and teams in the tooltip. **Show only my PRs awaiting review** in the view's … menu hides the others in Mine.
- Review requests say whether GitHub asked you **Direct** or **via** one of your teams. The list already included team requests.
- Each repository has a collapsed **All open** group, and the role view an **All open** section, listing every open PR. It loads when you expand it, and its rows work like the others.
- The review page draws check marks, crosses and dots as straight codicon icons instead of font glyphs, in checks, reviewers, commits, the merge box, linked issues, read lines and Claude's step log.
- The Checks list shows only the icon and the check's name. Hovering the icon, or a screen reader, still gives the state: Passed, Failed, Running or Skipped.
- The expand arrow on Claude's commits inside a thread lines up with the commit's text.
- While Claude runs on a PR, the review page shows a stop icon next to its steps in the header and in the thread Claude is answering. It stops the run, the header reads **Claude stopped**, the threads it was answering read **Stopped**, and **Retry** sends them again. No failure message pops up for a run you stopped.
- **Implement** in a reply to a Local thread works without a note: Claude implements what the thread discussed. A new comment still needs text, and **Ask Claude** still needs a note.
- The comment icon in a file's header on the review page opens a comment about the whole file above its diff. The thread stays there, reads **Whole file** instead of a line, and Claude is told the comment is about the file, not about lines. Posting it on GitHub makes a file-level comment.
- Local threads have **Archive** next to **Resolve**. Archived threads leave the page and the Threads card; **Show archived threads** in the Files filter menu brings them back with **Unarchive**. Archiving keeps the conversation and is separate from resolving.
- Messages in Local threads render bold around inline code or emphasis (`**Use `retry()` here**`), `__bold__`, and fenced code inside list items, with syntax highlighting and without the list's indent. `diff` and `patch` fences are highlighted.
- The review page asks its questions in the page instead of VS Code dialogs. **Close pull request**, **Delete branch** and **Revert** turn their row into the question with **Cancel** and a confirm button; deleting a comment asks under the comment. **Remove worktree**, **Discard**, **Approve and run** and a new base branch ask in a small menu under their button. Hiding a comment picks the reason from a menu under **Hide**, **Update branch** picks merge or rebase from a menu, and **Edit title** and **Dismiss review** edit in place. **Revert** reports the new PR in the page notice with a link.
- **Merge** is its own confirm button: the first click opens the commit message and turns it into **Confirm squash and merge**, the second merges. A **Delete branch** checkbox replaces the second "Merge and delete branch" dialog. **Enable auto-merge** works the same way. The merge method is a page menu instead of a dropdown.
- While Claude works, the review page shows Clawd, Claude's pixel mascot, instead of a pulsing dot. Each time the page opens it picks one of four animations: a hop, a squash hop, a sideways scuttle or typing. With reduced motion on, Clawd stands still.
- While Claude runs, the review page header, a thread's live box and the Guide card show its last three steps like a Claude Code transcript: `Edit(src/retry.ts)` with Claude's latest sentence under the current step, and the exact result under finished ones, such as "Read 120 lines" or a failed command's last output line. The current step shows how long the run has taken. Clawd's animation no longer restarts when the status changes.
- **Open in terminal** works while Claude runs. It reads **Stop and open in terminal**, stops the background run, and continues the conversation in the terminal; the comments Claude was answering wait for **Retry**.
- **Commit suggestion** works while Claude has unpushed commits. The suggestion becomes one more local commit after them, and **Push N commits** pushes them together. It failed with "The PR worktree has commits that are not on GitHub" before. A GitHub suggestion whose file the unpushed commits change still asks you to push first, since its lines may have moved.
- **Commit suggestion** also works when Claude's unpushed commits build on an older PR commit, or rewrote pushed ones, after GitHub got newer commits. The suggestion becomes one more local commit and nothing is dropped. When the worktree can't follow GitHub, the page says to rebase the unpushed commits onto the PR's latest commit instead of asking to push them, which GitHub would reject.
- The merge box says "Auto-merge is off in this repository's settings." when the repository doesn't allow auto-merge, instead of hiding **Enable auto-merge** without a reason. An auto-merge request GitHub doesn't offer reports why instead of closing the form as if it worked.
- Claude writes `suggestion` blocks only for changes within the commented lines. Changes to other lines or files come as a `diff` block per file, so they no longer show up as a one-line **Commit suggestion**.
- **Ask Claude** and **Implement** stay disabled until a new comment has text.
- Avatars no longer reload and blink each time Claude updates a thread.
- Closing or cleaning up a PR stops its Claude even when the run was still starting, and kills a Claude that ignores the stop signal after 5 seconds. A Claude could keep running for hours after its worktree was removed before.
- The Pull Requests view has a **Pinned** section above Review requested and Mine. Pin a PR with the pin icon on its row, or drag it onto **Pinned**; drag pinned rows to reorder them. A pinned PR leaves its role section, stays pinned after it drops out of your review requests, and is unpinned once GitHub reports it merged or closed.
- A thread's header on the review page stays at the top while you scroll through a long thread, so you can collapse it from there. Collapsing keeps the header where it was on screen.
- Threads with more than four messages show only the latest three, with **Show N earlier messages** above them, which turns into **Hide N earlier messages** once shown.
- On your own PR, Claude answers Local threads in auto mode, so **Implement** can run tests, builds and git commands. Before, it could only edit files and refused every command.
- Claude can read and search the workspace's other folders while answering a Local thread.
- On your own PR, Claude commits what it changes for a Local thread and does not push. The thread lists each commit with **Not pushed** until GitHub has it. The chevron before a commit unfolds its changes inside the thread; the hash shows the commit in the Files tab. **Push N commits** in the files bar pushes them, and **Show changes** next to it opens every commit GitHub does not have yet in the Files tab. The range menu lists those commits after the PR's, marked **Not pushed**, with a **Not pushed** entry that picks them all.
- **Open in terminal** on the review page replaces **Show log**. It continues the PR's Claude conversation in a VS Code terminal with the same tools and limits. It is off while Claude answers in the background; a comment sent while the terminal conversation is open still starts a background answer in the same conversation. The log stays available from Claude's error message.
- Before Claude answers a Local thread, the worktree moves to the PR's latest commit on GitHub, so commits pushed from another checkout are never edited over. Local commits built on that commit stay. If the worktree went another way, the run stops and says why; if GitHub can't be reached, Claude works on the worktree as it is. The review page shows the new files when the worktree moves.
- The review page sends half as many GitHub requests after an action, loads the Conversation card together with the rest of the page, and redraws faster with many read marks.
- Refreshing the review page redraws only the files whose changes differ, instead of every file.
- **Dismiss review** is offered for every reviewer GitHub lists. Reviews by people without write access were missing from the review page's list before.
- Replies to a GitHub thread on the review page offer **Ask Claude** and **Implement** next to **Post on GitHub**. Claude gets the thread's comments and your note, which may be empty, in a Local thread on the same lines; nothing reaches GitHub. That thread's **Reply on GitHub…** posts Claude's answer inside the colleague's thread after you edit it. Outdated GitHub threads can't be handed to Claude, since their lines no longer match the code.
- The review page has a **Conversation** card like GitHub's Conversation tab: comments on the PR, reviews with their summaries, pushed commits, force pushes, label, reviewer, assignee, title, base branch, milestone and merge events, and mentions from other issues. A box at the bottom posts a comment on the PR outside any review. The card folds from its heading, and on long PRs it shows the latest six entries with **Show N earlier entries** above them.
- GitHub comments in the Conversation card and in diff threads can be edited by their author, quoted into a reply, hidden for a reason such as Outdated or Spam, shown again, and deleted. Hidden comments fold to one line with **Show**. Comments, reviews and the description take GitHub's eight reactions.
- Text boxes that post to GitHub have **Write** and **Preview** tabs, rendered by GitHub, and complete `@` mentions from the repository's people and everyone on the PR.
- **Discard** drops your pending review. Reviewer rows offer **Re-request review** and, with write access, **Dismiss review** with a reason.
- The range menu next to the Files and Guide tabs lists the PR's commits with their checks, changed files and lines. Click one to see only its changes, Shift-click another for the commits between, or pick **Since your last review**. Commit hashes in the Conversation card open that commit's changes. A note above the files names the commit shown. Lines can take comments only where they match the PR's latest version, and read marks need all changes.
- The Files tab can hide whitespace changes, filter files by name, by file type and by Viewed, with **Clear filters** in the filter menu, and folds generated files and large diffs by default, with a chip saying why. Keyboard shortcuts: `j`/`k` next or previous file, `n`/`p` next or previous comment, `v` toggle Viewed, `t` filter files, `?` list them.
- Checks show which are required, re-run the failed jobs of a GitHub Actions workflow, approve workflows waiting on a fork PR, and place check annotations under the lines they point at.
- GitHub suggestions in review threads offer **Commit suggestion** and **Add to batch** on PRs you can push to. **Commit N suggestions** in the files bar commits the batch as one commit and pushes it.
- The Merge box lists review, check and branch protection status, offers **Update branch** by merge or rebase when the branch is behind, lets you edit the merge commit title and message before merging, enables and disables auto-merge, adds the PR to a merge queue and removes it, opens a revert PR after merging and restores a deleted head branch.
- The sidebar shows the milestone, with a picker, and the issues the PR closes. The pencil after the base branch opens a filterable branch menu, asks to confirm, and changes the base; the diff follows.
- **Search pull requests** in the Pull Requests view finds PRs assigned to you, mentioning you, all open ones, recently closed or merged ones, or any GitHub search, and opens the review page for the one you pick.
- The header's Open on GitHub, Refresh and Remove worktree links are icon buttons. Text fields on the page show a thin focus line instead of the wide focus ring.
- Projects are not shown. Reading them needs the `read:project` sign-in scope, which would make everyone sign in to GitHub again.
- Replies in a local thread on the review page offer **Implement** next to **Ask Claude**, like a new comment. Every reply reused the thread's first choice before, so a thread started with Ask could never ask Claude to change the code.
- The Reviewers, Assignees and Labels gear buttons on the review page open a popover under the gear, with a filter box and a checkmark on selected items, instead of VS Code's picker at the top of the window. Labels show as on GitHub: a color dot, the name, and the description below it. Label chips in the sidebar lose their dot. Changes save when you click outside the popover or the gear again; Esc closes it without saving. The filter matches names only.
- The review page shows the PR number as a chip before the title, like the branch chips; clicking it copies the link to the PR.
- Comment authors without a loadable avatar, as on GitHub Enterprise, show their initials: from their profile name, or the first letter of their login when they set no name.
- Guide steps can show the unchanged lines around their changes, with the same expand buttons as the Files tab. The buttons were missing before.
- Resolving a thread on the review page folds it. It stayed open before.
- The PR you merge from the review page shows as Merged in the Pull Requests sidebar right away, with a purple merge icon. GitHub's search keeps listing a merged PR as open for a while.
- The **+** next to a hovered line number is smaller and lines up with the number, also on lines that wrap.
- Once you expand lines above a hunk, the expand row shows how many lines are still hidden instead of the hunk's `@@` header, which no longer sat next to its lines.
- Diff hunks on the review page take their syntax colors from the whole file. A hunk that started inside a docstring, comment or multi-line string showed the following code in string colors before.
- Re-read GitHub state after PR management actions even when a write fails partway through, so saved reviewer requests and completed merges do not leave a stale review page. Report potentially saved requests when withdrawal fails.
- Reject PR management messages without edit permission, and correctly preselect users whose login matches a team display name.
- Comments and Claude's replies render Markdown tables, with column alignment and inline code. They showed as raw pipes before.
- Code suggestions on the review page. **Suggest change** in the comment box starts a GitHub-style suggestion from the selected lines. Suggestions in local threads show as a small diff with **Publish suggestion**, which adds it to your pending GitHub review so the author can commit it there, and a button that uses it right away. Both refuse once the commented code changed. Claude on a PR now proposes code as suggestions and can offer up to three options to switch between. Suggestions show in the file's syntax colors and line up with the comment text. On a PR you can push to, **Commit suggestion** commits the option to the PR branch as "Apply suggestion from code review" and pushes it, like GitHub; a failed push takes the commit back. On other PRs, **Apply** changes the worktree only and the card offers **Discard**. The diff reloads either way.
- Comments Claude is waiting on or working on show a pulsing line inside the thread with Claude's current step, such as "Reading src/app.ts". The Threads card shows the same step. Sending a reply redraws only that file instead of the whole review page.
- **Fix conflicts** in the Merge box, when GitHub reports conflicts on a PR you can push to. The PR's Claude merges the base branch in its own conversation, resolves the conflicts, commits and pushes. It may run only the Git commands this needs. The worktree must have no uncommitted changes or unpushed commits. On someone else's PR, Git hooks stay off while Claude works. While Claude works, the Merge box shows its current step, such as "Running git merge". On your own PR, the review box shows only Comment, since GitHub lets you only comment there; the Merge box buttons line up on the right. When Claude stops because a conflict needs your decision, the Merge box shows its question with an answer box; **Fix conflicts** there sends your answer to the same conversation and tries again.
- The review page previews changed images, SVGs and PDFs, before and after side by side. Images show their size on a checkerboard so transparency is visible; SVGs keep their Diff and Preview switch; PDFs show their first 10 pages. Files over 20 MB are not previewed. PDF previews load pdf.js the first time a page needs it, which adds about 1.6 MB to the extension.
- Markdown, HTML, SVG, image and PDF files have their Diff and Preview switch in the Guide too.
- Markdown previews show images the file links from the repository, such as `![Chart](assets/chart.png)`. They showed a broken image before.
- The review page's file list has two tabs: **Files** with the file count, and **Guide** with the step count, a pulsing dot while Claude builds it, and Build guide. Unified and Split are a separate diff style that works in both tabs, so guide steps can show side by side. Switching tabs also switches the Pull Requests sidebar between files and guide steps.
- Every border and divider on the review page uses the theme's input border color, so file boxes, comments, code blocks and cards stand apart from the page even in themes where the panel border is near black. Comments no longer show a collapse arrow; click the header to fold them.
- Drag the definition panel's left edge to make it wider or narrower. The page remembers the width; double-click the edge to reset it.
- Hovering a diff line shows a **+** next to its line number, as on GitHub. Click it to comment on the line, or drag over the numbers to comment on a range.
- Cmd or Ctrl-click on a name with no definition shows a short hint that clears itself after a few seconds, on the next click or on Escape, instead of an error that stayed until clicked. When VS Code has no language support for the file, the hint offers **Find extension**, which searches the Marketplace for that file type.
- Filter the Pull Requests sidebar by author with the filter button in its title bar. The view's title shows the active author, and the filled filter icon clears it.
- PR rows in the sidebar list either their files or their guide steps, not both. The map and files buttons in the title bar switch between them; a PR without a guide always lists its files.
- PRs show their size and age. Sidebar rows end in lines added and removed, and their tooltip says when the PR was opened and last updated. The review page shows the same under the byline: Opened 3d ago · Updated 2h ago · +312 −48 in 14 files.
- The Pull Requests sidebar lists PRs of a repository that was renamed or moved on GitHub while your clone's remote still uses the old name. It showed none before.
- The PR rows in the sidebar no longer show inline buttons. Open review page, Show Claude activity, Open in browser and Remove worktree moved to the row's right-click menu, and the review page has a Remove worktree link next to Refresh.
- Manage the PR from the review page: edit the title and description, request or withdraw reviewers (people and teams), set assignees and labels, mark a draft ready for review or turn the PR back into a draft, close and reopen it, and delete its branch when merging or afterwards. Reviewers, assignees and labels open a VS Code picker. These controls show only when GitHub lets you edit the PR.
- The review page shows the PR's branches as chips you click to copy. Claude's status is a chip that pulses while Claude works. Panel headings are sentence case. Approve is the last button in its row.
- Threads say who can see them with an icon and a word: **Local**, **On GitHub** or **Guide** (Claude's notes, shown in the Guided layout). The full sentence moved to the label's tooltip. Threads no longer have a thick colored left border.
- The new-comment box sends with one click: Implement asks Claude for a change, Ask Claude asks a question. The dropdown is gone. The main button always sits at the bottom right, after Cancel.
- The files bar uses VS Code icons for Unified, Split, Guided and Folders, collapse and expand all files, and one button that collapses or expands all comments. Hovering an icon button shows what it does. Folders stays in place in Guided, greyed out, so the toolbar no longer shifts when you switch layouts. While Claude builds the guide, a pulsing chip next to Build guide shows its progress.
- Local Review is now Pair Review. The extension ID, settings (`pairReview.*`), commands, Claude plugin (`/pair-review:connect`) and PR worktree folder (`.git/pair-review`) use the new name. Settings, PR worktrees and PR handoff comments from Local Review are not carried over.
- On someone else's PR, Claude no longer loads the checkout's `CLAUDE.md`, skills, hooks, settings or MCP servers, for both the guide and answers to comments. The PR author controls those files. Your own user-level Claude setup still applies.
- Guided review on the review page: click **Build guide** and Claude reads the PR read-only, groups its changes by severity (Critical, Significant, Routine, Trivial), orders them for reading and explains each step. The **Guided** layout shows each step as a slice of the diff with its note, a note on the file, and a line on how it follows from the step before. Each step note is a thread marked **Guide** that you can reply to. Every change lands in exactly one step; changes the guide missed, or whose code changed since, go under Unclassified. A step's **Viewed** marks its lines read, so once every step is Viewed, every file is. Trivial changes start folded. Rebuild guide replaces notes nobody replied to. Each step has a short title, and the Pull Requests sidebar lists the steps under the PR as **Guide**, grouped by severity with a check on viewed steps; clicking a step opens the review page at it. On the review page, groups and steps hang off rails like a threaded discussion: a round button on each header folds it, curved lines join each step to its group, and headers stay on screen while you scroll.
- **Folders** on the review page's toolbar groups files by folder in the Unified and Split layouts, with the same rails as Guided. It is off by default and remembered. Each folder shows how many of its files are viewed, folds from its button or its rail, and keeps its header on screen while you scroll. Folders in the PR sidebar no longer show an icon next to VS Code's own fold arrow.
- Thread cards on the review page match the comment box: an even border instead of a colored side bar, and every button on the right, with the GitHub link first and Reply last. The status shows as a small label only when it adds something, so Guide notes no longer say Answered.
- Comments on the review page show the avatar beside the text instead of a name line above it, and a relative time (5m ago, 2d ago) that updates by itself; hover it for the exact time. Local and Guide messages drop the You and Claude line, since the avatar says who wrote it: Claude's orange mark, and your GitHub avatar for you. Pending sits on the right in amber, as on GitHub.
- Code blocks in comments on the review page use your theme's colors right away. Before, they could fall back to the default colors until the language was used elsewhere.
- The activity bar icon fills its square like VS Code's own icons instead of looking smaller.
- Delete your own GitHub comments from the review page with the trash icon, after a confirmation. Deleting a thread's only comment removes the thread.
- The review page's Threads card groups threads into GitHub, Local and Guide, each foldable with a count, and shows one line per thread in aligned columns: file and line, the text with code formatted, and the status on the right when it adds something. Clicking anywhere on a row jumps to the thread. Guide starts folded, since its notes already sit in the diff.
- Opening the comment box, switching it between Claude and GitHub, replying and expanding context redraw only that file instead of the whole review page, so they stay fast on large PRs. The comment box separates its actions: the send button stands out, Cancel sits on the right, and the shortcut hint reads as keys.
- Mark lines read on the review page: select lines like for a comment, then tick **Viewed** in the comment box's header. Read lines collapse to one row you can open or unmark. Marking added lines also covers the lines they replace. A mark follows its code when other lines move and lapses once that code changes. When every change in a file is read, the file is marked Viewed. Viewed ticks and read marks made in quick succession all stick, and a ticked file no longer opens again.
- The PR sidebar and review page do less repeated work in folders with many repositories. Claude progress and ticking a file redraw only that PR's row, and a file's hash is computed again only after the file changes. Diff editors find a PR's worktree without rescanning the workspace folder, and read a base file's content once. The review page loads its details and GitHub threads in one request and colors large diffs without blocking other extensions. Git remotes and GitHub's Viewed flags are read once per Refresh.
- Clicking an element in an HTML preview to comment keeps the page where it is instead of jumping to the top of the file.
- The PR sidebar lists every Git repository inside the workspace folder, such as a folder of service repositories. Repositories without open PRs are left out. A repository whose PRs cannot be loaded shows its error on one row without hiding the others.
- The PR sidebar groups by role by default: Review requested and Mine on top, repositories under them. Switch to Group by repository in the view's ... menu. Role and repository rows have their own icons and PR counts.
- The PR sidebar loads much faster with many repositories: two GitHub searches list the PRs of every repository at once, instead of two `gh pr list` calls per repository, and repository names come from git remotes instead of `gh repo view`. The lists from the last load show right away while fresh ones load.
- Choose repositories... in the PR sidebar's ... menu picks which repositories it lists, and Hide repository on a repository's right-click menu hides one. Hidden repositories are not queried, the choice is kept per workspace, and the view title shows how many are hidden.
- Support Node.js 20, the runtime SageMaker Code Editor uses for extensions and Claude hooks. Node.js 22 is no longer required.
- The PR overview became a review page: overview cards on top, every changed file below with syntax colors, a unified or split layout, a Viewed checkbox that collapses the file, and Open in editor for the native diff.
- Comment on the review page: click a line number, Shift-click to extend the range, and send a question or change request to Claude. Threads show inline under their lines with your messages, Claude's answers and status, plus Reply, Resolve and Publish to GitHub. Drafts survive redraws and reloads. Comments on lines the diff hides appear at the top of their file.
- The review page also shows GitHub comment threads from everyone, with Reply (posted on GitHub right away), Resolve and Open on GitHub. Each thread's header names its kind with its own mark: gray **Local**, terracotta **Analysis** with the Claude mark, or blue **GitHub**. Hover the name to see who can read the thread. A new comment or pending GitHub comment has a dashed border so a draft never looks like a posted thread.
- Comment straight on GitHub from the review page: switch the new-comment box from Claude to GitHub, then choose Add to review (pending until you submit the review) or Post now. GitHub only takes lines inside its diff, and the file must have no uncommitted changes.
- Clicking a PR or file in the sidebar opens the review page, scrolled to that file. The old all-files diff tab, its Viewed and unified/split buttons, and the proposed API they needed are gone.
- The review page has GitHub-style context: expand 20 lines up or down around each change, or Full file per file. Cmd/Ctrl-click a name to see its definition in a side panel, with Back, Open in editor and Escape to close.
- Claude's answers render as Markdown, GitHub comments as GitHub renders them. Pending GitHub comments are marked as only visible to you, and Post now is off while your review is in progress, since GitHub refuses single comments then.
- Code on the review page uses the same grammars and color theme as the editor, including grammars from installed language extensions and `editor.tokenColorCustomizations`. Files without an installed grammar, and a theme that is not plain JSON, fall back to the built-in colors.
- The definition panel shows up to 100 lines above and 400 below the definition to scroll through, marks the defined name, keeps strings and comments colored when the definition starts inside one, and has icon buttons for Back, Forward, Open in editor and Close.
- Holding Cmd or Ctrl on the review page underlines a name only when VS Code knows its definition.
- Added and removed lines on the review page line up with unchanged lines; the + or - sign no longer pushes the code to the right.
- GitHub comments show the author's profile picture and a Pending badge per comment, like GitHub. Code blocks in comments have their own background and border.
- Opening a PR no longer fails when its branch is checked out in another worktree. The review worktree now checks out the PR detached.
- Drag across line numbers to comment on several lines. Once you expand all hidden lines between two changes, the `@@` header between them goes away.
- Syntax colors for Swift, Go, Rust, Kotlin, Java, C, C++, C#, Objective-C, Ruby, PHP, Dart, Scala, SQL, HTML, XML, CSS, SCSS, Markdown, YAML and TOML.
- Markdown and HTML files get a Diff | Preview switch. In a Markdown preview, click a block to comment on its source lines, and threads show under their block. In an HTML preview, click an element to comment on its source lines. Its threads sit in a margin next to the element, which gets an outline. The file's own scripts stay off.
- The sidebar shows a PR's files as a folder tree, with single-folder chains folded into one row. The view's title bar switches between tree and list, like Source Control.
- Review page layout: description and threads on the left, reviewers, checks, finish review and merge in a right rail. The files toolbar has a Unified/Split toggle and Collapse/Expand for files and for comments.
- Open in editor on the review page opens that one file in VS Code's diff editor, and the button matches the Viewed checkbox size.
- The sidebar shows each PR's review state (Approved, Changes requested, Commented) as a colored icon and label. The overview shows it as a badge with reviewer names.
- On your own PRs, the overview shows Approve and Request changes disabled with the reason, instead of hiding them.
- The PR overview shows the description, reviewers, CI checks, a form to comment, approve or request changes, and a merge button.
- Comment threads show the Claude logo as avatar and label each message (Comment, Reply, Answer).
- Move the Review view out of Source Control into its own **Local Review** icon in the activity bar.
- Add a **Pull Requests** view that lists the repository's open PRs under **Mine** and **Review requested** through the existing `gh` login. Clicking a PR opens it in the browser for now.
- Expand a pull request in the sidebar to list its changed files. Clicking the PR or a file opens all of the PR's changes in one scrollable diff tab, scrolled to that file. Each PR is checked out into its own Git worktree in the background, and the diff compares against the point where the PR branched off its target. Diff headers show short `pr-<n>/<path>` names and mark added and deleted files like Git diffs. **Remove worktree** deletes a checkout and refuses while it has uncommitted changes.
- Comment inline on pull request diffs with `/a`, `/i` and `/r`. Each PR keeps its own comments and its own Claude conversation. PR comments show in the Review view with their PR number and return after a reload. The side composer is not available for PRs yet.
- Answer PR comments automatically: sending a comment starts Claude in the background in the PR's worktree with your `claude` login, and later comments resume the same conversation. Thread labels, the sidebar and the status bar show Claude's current step, such as "Reading src/app.ts". **Show Claude activity** on a PR opens the full log and sends failed or skipped comments again. On someone else's PR, Claude cannot edit files or run commands and proposes changes as diffs.
- Start a PR's Claude through your login shell, so your own `claude` setup (such as per-folder accounts) applies, and keep PR worktrees in the repository's `.git/local-review` folder. When a run fails, the thread says why (for example "Claude failed · Not logged in") and a notification offers Retry and the log. Thread labels also show "Thinking" and "Writing".
- Fix PR diff tabs restored after a reload showing "Resource not found": VS Code now starts Local Review as soon as it needs a PR file.
- Tick files as reviewed in a checked-out PR's file list. The PR row shows progress, such as "1/3 reviewed". Ticks sync both ways with GitHub's per-file "Viewed" checkbox, and a local tick clears itself when the file changes afterwards.
- Show PR files like Source Control: file-type icons and colored A, M, D and R letters.
- Publish a PR thread to GitHub from its thread or Review view action. An editable preview starts from Claude's last answer; post it into your pending review or as a comment right away. Comments outside the PR diff go on the whole file. Published threads show "On GitHub" and link to the comment.
- Add a PR overview tab, opened from the PR row: reviewed progress, Claude's current step with its log and retry, and every thread with its status and GitHub link.
- Leave untracked files out of PR diffs, so files tools create in a worktree (such as `.ui-review/`) no longer show up as PR changes.
- Add the `localReview.mockPullRequests` setting, which fills the Pull Requests view with sample data for testing.
- Let Git change listing compare against an explicit base commit, preparing PR review. Local review still compares against `HEAD`.

### ⚠ BREAKING CHANGES

* the extension ID is now pair-review-dev.pair-review. Settings move from localReview.* to pairReview.*, PR worktrees from .git/local-review to .git/pair-review, and the Claude plugin from local-review to pair-review. Nothing is migrated.
* **github:** sign in through vs code instead of the github cli

### Features

* **ci:** automate releases with release please and marketplace publishing ([6d5e3bf](https://github.com/kaiketsu-labs/pair-review/commit/6d5e3bfb6fbdf00331d1c824dae8c5f46028e39c))
* **ci:** switch release workflow to release please and marketplace publishing ([e0708ff](https://github.com/kaiketsu-labs/pair-review/commit/e0708ffc7e81c2759523ca506ee06f973321d37d))
* **claude:** commit, preview and push Claude's changes from the review page ([e145e8b](https://github.com/kaiketsu-labs/pair-review/commit/e145e8b624487321965306d2c84e34a958ca7d2f))
* **github:** sign in through vs code instead of the github cli ([f948502](https://github.com/kaiketsu-labs/pair-review/commit/f94850217be31da8dd81fe5b32c730e87c3da8fa))
* new design and PR management on the review page ([#8](https://github.com/kaiketsu-labs/pair-review/issues/8)) ([e5584f6](https://github.com/kaiketsu-labs/pair-review/commit/e5584f61c5f288d83c1b8cde5c3e41c37c593b08))
* **pr:** add custom review instructions and isolate untrusted checkouts ([99dc317](https://github.com/kaiketsu-labs/pair-review/commit/99dc3174c1b11c41f3576a77c4b4ab0ebd3f66db))
* **pr:** add guided review and threaded file layout ([8288a10](https://github.com/kaiketsu-labs/pair-review/commit/8288a1076ae16966efc837c17647619a09d4d326))
* **pr:** add pull request review workbench ([2b7e8d7](https://github.com/kaiketsu-labs/pair-review/commit/2b7e8d7422279810e8a7a4b41c0f61ea562f3889))
* **pr:** ask on the review page instead of in VS Code dialogs ([#28](https://github.com/kaiketsu-labs/pair-review/issues/28)) ([056f5ef](https://github.com/kaiketsu-labs/pair-review/commit/056f5efae39b1220a7e94173c280327a3930dd9d))
* **pr:** bring the review page to parity with GitHub's pull request page ([#24](https://github.com/kaiketsu-labs/pair-review/issues/24)) ([65d4e74](https://github.com/kaiketsu-labs/pair-review/commit/65d4e74df60959d4c639eb12d3f5cfa1d00bbf66))
* **pr:** code suggestions with options from Claude, apply and publish ([#18](https://github.com/kaiketsu-labs/pair-review/issues/18)) ([8020b0b](https://github.com/kaiketsu-labs/pair-review/commit/8020b0bfc0a8ae799a5e96b523df4e438ae09891))
* prepare for VS Code Marketplace and Open VSX release ([#27](https://github.com/kaiketsu-labs/pair-review/issues/27)) ([a534633](https://github.com/kaiketsu-labs/pair-review/commit/a5346332db85760534fb1b348884760908449e4f))
* **pr:** files and guide tabs, resizable definition panel, comment plus on hover ([#15](https://github.com/kaiketsu-labs/pair-review/issues/15)) ([06c42b7](https://github.com/kaiketsu-labs/pair-review/commit/06c42b71bb46524c5e5c3977edbf837b7a56c95a))
* **pr:** filter sidebar by author, show files or guide, PR dates and size ([#13](https://github.com/kaiketsu-labs/pair-review/issues/13)) ([51a76e8](https://github.com/kaiketsu-labs/pair-review/commit/51a76e8830365d498b0cfc39677260ea8407d980))
* **pr:** hand GitHub threads to Claude from the review page ([a04561e](https://github.com/kaiketsu-labs/pair-review/commit/a04561e6566fdb15205b9ccc25f0f19ffe2bc222))
* **pr:** jump to and mark guide sections read ([12782d5](https://github.com/kaiketsu-labs/pair-review/commit/12782d58dedc4619c812ba622fefb48dfdd4479d))
* **pr:** keep PRs in sync with GitHub ([30df344](https://github.com/kaiketsu-labs/pair-review/commit/30df344c8a91725d8a41a578443b0b2c13093611))
* **pr:** list pull requests of nested repositories ([061bfa3](https://github.com/kaiketsu-labs/pair-review/commit/061bfa3415719c1ac35917dbb77cb3e0e89d715c))
* **pr:** live Claude status on comments and fix conflicts with Claude ([#17](https://github.com/kaiketsu-labs/pair-review/issues/17)) ([444b759](https://github.com/kaiketsu-labs/pair-review/commit/444b75919677015c9df68b99ac28327e4f7dd659))
* **pr:** mark line ranges read and speed up the review page ([4e8c908](https://github.com/kaiketsu-labs/pair-review/commit/4e8c908d2c8cc9f830265c32374660fef71b6d81))
* **pr:** nest Claude's threads in their GitHub thread and give local threads titles ([0b8e248](https://github.com/kaiketsu-labs/pair-review/commit/0b8e248c9567e7a515053ea620543cf98e5b97d3))
* **pr:** open prs by link and show review requests in the sidebar ([1aa8a22](https://github.com/kaiketsu-labs/pair-review/commit/1aa8a221671a1103206c6277553f48e78a419885))
* **pr:** pick reviewers, assignees and labels in a popover ([360d195](https://github.com/kaiketsu-labs/pair-review/commit/360d1954c27924a49efc484bf4e55415e023bef8))
* **pr:** pin PRs in the sidebar and tame long threads on the review page ([fe5ea57](https://github.com/kaiketsu-labs/pair-review/commit/fe5ea57c459dabe5d554abe27323f5ad72477e9a))
* **pr:** post Claude's threads on GitHub from the review page ([2f85582](https://github.com/kaiketsu-labs/pair-review/commit/2f855821b91ff08ef48aed6d1b11715079ec63d4))
* **pr:** preview images, SVGs and PDFs, and Markdown in the guide ([#16](https://github.com/kaiketsu-labs/pair-review/issues/16)) ([52cbadc](https://github.com/kaiketsu-labs/pair-review/commit/52cbadc9d1461678661c686d4202f846d4da0780))
* **pr:** show Claude's runs as a Clawd step log and hop into its reply ([0755f09](https://github.com/kaiketsu-labs/pair-review/commit/0755f0978cc81cb4867773a3d435000886c65a60))
* **pr:** speed up the sidebar and color code like the editor ([0351fd8](https://github.com/kaiketsu-labs/pair-review/commit/0351fd82be4e8fcb91080fb93ff14453ba89a3ba))
* **pr:** stop claude, archive threads and comment on whole files ([976ac9f](https://github.com/kaiketsu-labs/pair-review/commit/976ac9fb64c4b4858749398a2acd062098ff206e))
* rename local-review to pair-review ([718d2cf](https://github.com/kaiketsu-labs/pair-review/commit/718d2cf4ee402ed7c6338b8007a17a597d1cbbb6))


### Bug Fixes

* **ci:** avoid secrets context in workflow if conditions ([14f9d6c](https://github.com/kaiketsu-labs/pair-review/commit/14f9d6c49d9416d59d5af77d9e0519a77685789c))
* **ci:** handle marketplace tokens and oidc inside release steps ([b63b8f4](https://github.com/kaiketsu-labs/pair-review/commit/b63b8f417232486ef553cb5145e1f851e9cb3e8c))
* **claude:** let Local threads run commands and start from the PR's latest commit ([#25](https://github.com/kaiketsu-labs/pair-review/issues/25)) ([487d33e](https://github.com/kaiketsu-labs/pair-review/commit/487d33e221a38b40544df90cef1aec23943c2d8f))
* **github:** fall back to the gh cli token when vs code has no sign-in ([a4832d8](https://github.com/kaiketsu-labs/pair-review/commit/a4832d88f5cec88cde22a36f0ee0e9bf72f7114b))
* **pr-management:** refresh partial writes and guard editing permissions ([#10](https://github.com/kaiketsu-labs/pair-review/issues/10)) ([dfa68f5](https://github.com/kaiketsu-labs/pair-review/commit/dfa68f597acc96d99a036325dacded7dd1bbeff8))
* **pr:** clear the missing-definition hint and find same-file definitions ([#14](https://github.com/kaiketsu-labs/pair-review/issues/14)) ([fd12e0f](https://github.com/kaiketsu-labs/pair-review/commit/fd12e0f239cf34be08e4f70919b0282279cfa66c))
* **pr:** color diff hunks from the whole file ([#23](https://github.com/kaiketsu-labs/pair-review/issues/23)) ([e88ec84](https://github.com/kaiketsu-labs/pair-review/commit/e88ec84c37200024ba8082285b3dd4477e686a6e))
* **pr:** color the pending chip GitHub yellow ([bf8bc41](https://github.com/kaiketsu-labs/pair-review/commit/bf8bc41008a09b181035a0d771dbe80ffea8112d))
* **pr:** commit suggestions after unpushed commits and stop leaked claude runs ([3929581](https://github.com/kaiketsu-labs/pair-review/commit/39295816671d22098911baa84f428614880e0b0d))
* **pr:** commit suggestions over diverged local commits and explain missing auto-merge ([cd6eed2](https://github.com/kaiketsu-labs/pair-review/commit/cd6eed2545bbfd9cfc3f521fe122c4f5612456f5))
* **pr:** give all open rows their own tree ids ([b490132](https://github.com/kaiketsu-labs/pair-review/commit/b490132bedd1314df3e428121cb0c80c94fecb7e))
* **pr:** guide expanders, fold resolved threads, mark merged PRs ([7a56367](https://github.com/kaiketsu-labs/pair-review/commit/7a56367a37914b0bcd930b5cb1e0fbe433ac6e9a))
* **pr:** keep read marks once they outgrow 64 KB ([430f878](https://github.com/kaiketsu-labs/pair-review/commit/430f87875a93590ce0b693cf2ba44f4b0f8d7cde))
* **pr:** keep the review page and sidebar steady ([4896a01](https://github.com/kaiketsu-labs/pair-review/commit/4896a01d49409dfbacfe4ae754fd2e927a3f8195))
* **pr:** keep the scroll position when commenting in html previews ([09a79ef](https://github.com/kaiketsu-labs/pair-review/commit/09a79ef18c93c852d01302d32a1a670d6f6b747b))
* **pr:** let local replies ask Claude to implement ([ff0e029](https://github.com/kaiketsu-labs/pair-review/commit/ff0e02996f071c11f3b2979f6ae3775c3887f2ec))
* **pr:** list every latest review for dismissing ([f02afbf](https://github.com/kaiketsu-labs/pair-review/commit/f02afbf8824d8c70f733106ccc3dbf6bc060e882))
* **pr:** list PRs of repositories renamed on GitHub ([#20](https://github.com/kaiketsu-labs/pair-review/issues/20)) ([1d83fac](https://github.com/kaiketsu-labs/pair-review/commit/1d83fac09b84b7495a429743cc92be2e951b56f7))
* **pr:** move worktrees to .claude/worktrees and clean them up ([#12](https://github.com/kaiketsu-labs/pair-review/issues/12)) ([5c8f335](https://github.com/kaiketsu-labs/pair-review/commit/5c8f335002669cd68fd01d9a3797fa2df2f7ac6c))
* **pr:** render markdown tables in comments and replies ([#21](https://github.com/kaiketsu-labs/pair-review/issues/21)) ([0fe7974](https://github.com/kaiketsu-labs/pair-review/commit/0fe7974d917081340351063e910cec82db75faf4))
* **pr:** request read:org so the review page loads details ([#9](https://github.com/kaiketsu-labs/pair-review/issues/9)) ([c5b4bbf](https://github.com/kaiketsu-labs/pair-review/commit/c5b4bbfc5e51e162884bc92d37c03efb34c46b2b))
* **pr:** show initials when a comment avatar is missing or fails to load ([eb365ac](https://github.com/kaiketsu-labs/pair-review/commit/eb365ac510838c64d186810f66e1530b540bddbb))
* **pr:** show stopped threads as stopped and retry them ([64b221b](https://github.com/kaiketsu-labs/pair-review/commit/64b221beacad9a27cebc7f5a7748fe7d99717f6a))
* **pr:** stop a state refresh from undoing Viewed ticks still being saved ([af6cb4f](https://github.com/kaiketsu-labs/pair-review/commit/af6cb4fb70f080a1e5b6f67edea850cb2bf056df))
* **pr:** stop claude for real and show a stop icon ([d9578e7](https://github.com/kaiketsu-labs/pair-review/commit/d9578e735bd7ddde8d6af1a35a5ba420868b2f09))
* **pr:** stop claude from the thread it is answering ([8f9f3c4](https://github.com/kaiketsu-labs/pair-review/commit/8f9f3c48d5272bcb1bc67e59e11dcb6e322740de))
* **runtime:** support node.js 20 ([2d6bf4a](https://github.com/kaiketsu-labs/pair-review/commit/2d6bf4a6cb14959b3c6b9ad2b82bd75384ab7ed1))


### Performance Improvements

* **pr:** fewer GitHub reads and faster review page redraws ([8b814e9](https://github.com/kaiketsu-labs/pair-review/commit/8b814e978ad625a5d20d3eba0ab08b03873be956))
* **pr:** redraw only changed prs and cache per-pr state ([3c4c85e](https://github.com/kaiketsu-labs/pair-review/commit/3c4c85ea2b00905e73ca7392fec62eb7a20cdbc4))


### Miscellaneous Chores

* bump minor pre major in release-please ([#33](https://github.com/kaiketsu-labs/pair-review/issues/33)) ([f90b6cb](https://github.com/kaiketsu-labs/pair-review/commit/f90b6cb2babf2188c45d75df3e87759963e4b40d))

## 0.4.12

- Search this project's recent Claude conversations by name or branch in VS Code; show which ones are running and retain Claude's own picker as a fallback.
- Connect an already-running Claude Code 2.1.280+ conversation through a project-local plugin and two copyable commands. The original process and conversation stay active; only the explicitly selected session receives plugin feedback.
- Preserve the current selection when copying a new/resume command; release it only when that command runs, refusing a stale handoff to another selected session.
- Allow trusted workspace overrides for Claude and Node executable paths and report an outdated Claude version before installing the live plugin.
- Add the organization README banner, quick-start choices and connection documentation. Keep credentials and runtime connection files outside Git.
- Pass strict TypeScript and 256 tests. Verify authenticated attachment and a formatted inline reply in VS Code with unchanged process/session identity; record remaining cross-terminal and competing-live-session checks separately.

## 0.4.11

- Remove VS Code's inherited inline-code background strips and padding from the composer preview, keeping one clean syntax-colored code card.
- Reuse an existing source editor when opening code from the composer, including a source displayed in a diff. Repeated navigation no longer creates extra editor columns.
- Reset preview scrolling when changing the selected code target, while preserving the reading position when reopening the same target.

## 0.4.10

- Replace the bulky side-composer context stack with one compact file reference, editor icon and syntax-colored selected-code card. Remove duplicate surrounding context, branding and the pinned-reply badge from the display; captured context stays attached to feedback.
- Highlight Python, JavaScript, TypeScript, JSON and shell snippets in light and dark themes. Unsupported or large snippets remain escaped plain text; previews preserve the exact source.
- Soften the native reply surface and outline, and label its entry action **Antworten …**. The project appearance action uses VS Code's shared contrast-border color, preserves high-contrast themes, and can restore older appearance backups.

## 0.4.9

- Shorten the conversation-picker hint so the required `/exit` instruction stays visible in the native dialog.
- Make Node startup failures report the selected executable and bounded failure details instead of implying every failure is a path problem.
- Explain that a connection may still be disconnecting for up to 45 seconds after Claude exits, without incorrectly reporting another active session.

## 0.4.8

- Choose a specific saved Claude conversation through its native session picker, or start a new one. Resume keeps history and replaces the previous automatic “latest conversation” selection.
- Copy a safely quoted project-aware connection command for a separate terminal, with the same existing/new choices and private review configuration.
- Make managed-session switching explicit, preserve sessions when selection is cancelled or setup fails, and avoid launching over an active external feedback receiver.
- Explain that an already-running conversation must currently be exited and resumed; in-place plugin attachment remains unverified follow-up work.

## 0.4.7

- Keep existing native comment objects during status updates; show filename and line in the Review list, and expose the contrast action directly in its toolbar.
- Add optional **Zentrierte Ansicht** in the Review overflow menu, using VS Code's native centered layout to narrow source and inline comments together. Independent native comment width is unavailable; diffs may still expand automatically.
- Preserve code captured by command-created inline drafts while the source changes; reopen saved context when a safe current match is unavailable. VS Code's own gutter drafts still capture context at send time.
- Preserve active text composition in the optional composer and PR preview; explain bare `/r` on a new side-composer comment without changing the existing-thread shortcut.
- Keep edited or failed PR handoffs recoverable after closing within the current VS Code session, retaining their exact snapshot; explicitly choose a new snapshot when needed.
- Mark post-publication edits as unpublished, prevent repeated sends of unchanged published text, and improve PR-preview wrapping in narrow panes.
- Distinguish automatic-delivery readiness from MCP activity and event acknowledgments. Older helpers require a reconnect to report readiness; reuse the project's managed terminal after an editor reload.
- Write private connection settings atomically. Strict TypeScript and 210 automated tests pass; native and live-agent evidence is tracked separately in the QA report.

## 0.4.6

- Keep appearance actions responsive while success, high-contrast or error notifications remain open. Restoring or reapplying project colors no longer waits for a notification to be dismissed.
- Verify the distinct native thread surface and darker reply field in a real dark-theme workspace, including after focus leaves the reply field.

## 0.4.5

- Add a project-scoped appearance action that gives native review conversations a distinct surface and persistent neutral frame, including when unfocused.
- Preserve unrelated colors and theme settings; restore prior project values with a separate reset action, retaining later manual edits.
- Scope the contrast colors to the current dark/light theme and retain native high-contrast colors.

## 0.4.4

- Add end-to-end regression evidence for silent unacknowledged rearming and live bridge replacement; record a real headless Claude ask/implement/summarize roundtrip separately from pending interactive UI checks.
- Remember hook deliveries per Claude session so normal tool/Stop rearming does not repeatedly wake Claude for the same unacknowledged comment; explicitly recover unfinished work on session start/resume.
- Lead hook messages with file, mode and a short feedback excerpt, sharing the formatting/action contract once per batch; ignore subagent hooks.
- Keep superseded events as conversation history instead of reviving them as fresh work after the latest request is complete.
- Hide resolved conversations from native editor comments, the Comments panel and Review list by default; add a saved show/hide control and quick resolve/reopen actions.

## 0.4.3

- Format obvious legacy JSDoc comments attached to exported JavaScript/TypeScript declarations as code cards, including a standalone function header ending at its opening brace.
- Preserve the original snippet, surrounding explanation and saved review text; never invent a missing function body or closing brace.
- Clarify that agent reply formatting also applies to doc comments and incomplete function headers.

## 0.4.2

- Move the code-reference icon to the native comment header beside the author and timestamp; remove the extra action row from reply text.
- Open single code targets directly and use one compact picker for replies containing multiple code blocks.
- Bind header actions to extension-owned native comments; reply Markdown no longer needs permission to run commands.

## 0.4.1

- Present native code blocks as darker rounded cards with a visible frame, real inner spacing and a compact file/language header; stored code remains unchanged.
- Replace long native code-navigation links with compact editor icons and descriptive tooltips.
- Shorten selection and PR-preview copy; use an accessible editor icon in the side composer too.
- Reduce the repeated reply-format reminder from 562 to 118 characters; keep the full contract on the reply tool.
- Redraw the flow as a clean, neutral code-review loop focused on collaborating with an agent.
- Explain the workflow in plain language and document existing macOS Dictation for comment input.

## 0.4.0

- Display clearly recognized, unfenced JavaScript/TypeScript declarations in a code box, including existing replies; keep original stored text and explanatory prose intact.
- Accept uppercase `/A`, `/I` and `/R` shortcuts as well as lowercase ones.
- Use clear system UI and monospace fonts in extension-owned panels; avoid inheriting novelty fonts.
- Add an illustrated feedback flow and explain local long polling, automatic hook delivery, MCP replies and the separate GitHub handoff.
- Give unlabeled fenced code the review file's language for native VS Code syntax coloring, without changing stored replies.
- Add **Im Editor öffnen** actions to reply code blocks and the optional composer's selected code.
- Open confirmed, uniquely matching current project code in its existing editor, retaining the chat and its draft. Native hover, Cmd/Ctrl-click and F12 then use the installed language support.
- Show proposed, changed or ambiguous code in a read-only syntax-colored preview instead of guessing a source location. Project semantics are limited there; native Markdown code blocks remain display-only.
- Validate generated code links through opaque session handles and re-read durable review data on every click. Reopen saved review snippets after a window reload.

## 0.3.1

- Add distinct human and Claude avatars to native conversations, including the identity beside inline replies.
- Shorten thread headings and status labels while preserving delivery and review states.
- Restyle the optional side composer with a single rounded input card, mint accents, quieter code context, clearer file hierarchy and compact actions.
- Preserve theme colors, visible keyboard focus, explicit high-contrast borders and narrow-panel wrapping. Native comment layout remains controlled by VS Code.

## 0.3.0

- Make native inline input the default: gutter plus, direct replies, one send action and `/a`, `/i`, `/r` shortcuts evaluated on send.
- Restore commenting ranges on local files and both sides of Local Review diffs.
- Keep the optional side composer open after sending, follow explicit new selections without focus changes, and preserve written drafts on their original code.
- Highlight the accepted selected lines independently of editor focus and separate selected code from surrounding context.
- Make the side composer smaller with a compact header, mode buttons, bounded code preview and content-sized input.
- Require Markdown code fences, indentation and real line breaks in agent replies; add a formatted-code MCP round-trip regression.
- Share in-flight inline submissions, preserve replies on saved code context, and prevent discarding a draft during submission.
- Add ten composer protocol regressions and four submission gate regressions. Strict TypeScript checking and all 73 automated tests pass.

## 0.2.1

- Add a mint-on-navy extension icon matching the demo's code-and-conversation identity.
- Include a matching monochrome Review view icon and package both assets in the VSIX.

## 0.2.0

- Add a controlled feedback composer with visible live `/a`, `/i`, and `/r` mode switching and one explicit send action.
- Save unsent drafts in workspace storage and offer explicit draft recovery.
- Keep submitted conversations inline and open replies through the same composer.
- Support feedback shortcuts on original-side Local Review documents.
- Add a separate preview-and-publish action for summaries and unresolved questions on the current branch's GitHub PR, with managed-comment updates.
- Revise the staged demo to begin with Claude coding, then review feedback, and add an original quiet ambient soundtrack.

## 0.1.1

- Preserve comment drafts when submission fails.
- Restore threads only on confirmed code locations and display saved context when uncertain.
- Keep comparison editors open while navigating review conversations.
- Reconnect after Claude exits, and rearm delivery after tool use.
- Bound new feedback before persistence and isolate legacy oversized review context.
- Recover unfinished work when a channel reconnects.
- Summarize existing threads without requiring additional text.
- Show renamed files as separate deletion and addition for complete local review.
- Add targeted regression cases, GitHub installation/publishing documentation, and a staged demo.

## 0.1.0

Native inline reviews with automatic per-comment delivery to Claude Code, persistent threads, explicit acknowledgments, and replies in the editor.
