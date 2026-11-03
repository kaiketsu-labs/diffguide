# Changelog

## Unreleased

- The review page shows the description, reviewers and checks again. GitHub refused that request because reading team reviewer names needs the `read:org` scope. Pair Review now asks for it, so VS Code asks you to sign in to GitHub once more.
- Local Review is now Pair Review. The extension ID, settings (`pairReview.*`), commands, Claude plugin (`/pair-review:connect`) and PR worktree folder (`.git/pair-review`) use the new name. Settings, PR worktrees and PR handoff comments from Local Review are not carried over.
- On someone else's PR, Claude no longer loads the checkout's `CLAUDE.md`, skills, hooks, settings or MCP servers, for both Analyze and answers to comments. The PR author controls those files. Your own user-level Claude setup still applies.
- Add your own instructions for **Analyze** (`analysis.md`) and for answers to review comments (`ask.md`) in `.claude/pair-review/` folders: in Claude's config folder, parent folders of the project, the repository, or Claude's per-project folder. Claude gets them after the built-in instructions, most specific last. On someone else's PR, the repository's file is read from the base branch. See [Usage](docs/USAGE.md#your-own-instructions-for-claude).
- Guided review on the review page: click **Analyze** and Claude reads the PR read-only, groups its changes by severity (Critical, Significant, Routine, Trivial), orders them for reading and explains each step. The **Guided** layout shows each step as a slice of the diff with its note, a note on the file, and a line on how it follows from the step before. Each step note is a thread marked **Analysis** that you can reply to. Every change lands in exactly one step; changes the analysis missed, or whose code changed since, go under Unclassified. A step's **Viewed** marks its lines read, so once every step is Viewed, every file is. Trivial changes start folded. Analyze again replaces notes nobody replied to. Each step has a short title, and the Pull Requests sidebar lists the steps under the PR as **Guided review**, grouped by severity with a check on viewed steps; clicking a step opens the review page at it. On the review page, groups and steps hang off rails like a threaded discussion: a round button on each header folds it, curved lines join each step to its group, and headers stay on screen while you scroll.
- **Folders** on the review page's toolbar groups files by folder in the Unified and Split layouts, with the same rails as Guided. It is off by default and remembered. Each folder shows how many of its files are viewed, folds from its button or its rail, and keeps its header on screen while you scroll. Folders in the PR sidebar no longer show an icon next to VS Code's own fold arrow.
- Thread cards on the review page match the comment box: an even border instead of a colored side bar, a filled Reply button, an outlined Resolve, and the GitHub link on the right. The status shows as a small label only when it adds something, so Analysis notes no longer say Answered.
- Delete your own GitHub comments from the review page with the trash icon, after a confirmation. Deleting a thread's only comment removes the thread.
- The review page's Threads card groups threads into GitHub, Local and Analysis, each foldable with a count, and shows one line per thread. Analysis starts folded, since its notes already sit in the diff.

- Opening the comment box, switching it between Claude and GitHub, replying and expanding context redraw only that file instead of the whole review page, so they stay fast on large PRs. The comment box separates its actions: the send button stands out, Cancel sits on the right, and the shortcut hint reads as keys.
- Mark lines read on the review page: select lines like for a comment, then tick **Viewed** in the comment box's header. Read lines collapse to one row you can open or unmark. Marking added lines also covers the lines they replace. A mark follows its code when other lines move and lapses once that code changes. When every change in a file is read, the file is marked Viewed. Viewed ticks and read marks made in quick succession all stick, and a ticked file no longer opens again.
- The PR sidebar and review page do less repeated work in folders with many repositories. Claude progress and ticking a file redraw only that PR's row, and a file's hash is computed again only after the file changes. Diff editors find a PR's worktree without rescanning the workspace folder, and read a base file's content once. The review page loads its details and GitHub threads in one request and colors large diffs without blocking other extensions. Git remotes and GitHub's Viewed flags are read once per Refresh.
- Pair Review no longer needs the GitHub CLI. The PR sidebar, review page and PR handoff sign in with your GitHub account in VS Code. When you are signed out, the Pull Requests view shows a **Sign in to GitHub** button (also **Pair Review: Sign in to GitHub** in the Command Palette), and PR handoff asks you to sign in. The sidebar reloads after sign-in. GitHub Enterprise works for the one host set in `github-enterprise.uri`.
- Clicking an element in an HTML preview to comment keeps the page where it is instead of jumping to the top of the file.
- The PR sidebar lists every Git repository inside the workspace folder, such as a folder of service repositories. Repositories without open PRs are left out. A repository whose PRs cannot be loaded shows its error on one row without hiding the others.
- The PR sidebar groups by role by default: Review requested and Mine on top, repositories under them. Switch to Group by repository in the view's ... menu. Role and repository rows have their own icons and PR counts.
- The PR sidebar loads much faster with many repositories: two GitHub searches list the PRs of every repository at once, instead of two `gh pr list` calls per repository, and repository names come from git remotes instead of `gh repo view`. The lists from the last load show right away while fresh ones load.
- The PR sidebar fills as soon as it opens: Pair Review starts when the view is shown, registers the view before its other setup, and finds nested repositories by scanning the workspace folder (honoring `git.repositoryScanMaxDepth` and `git.repositoryScanIgnoredFolders`) instead of waiting for the Git extension's scan.
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
