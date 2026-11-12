# Install DiffGuide

DiffGuide is a preview on the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=kaiketsu-labs.diffguide). Each [GitHub release](https://github.com/kaiketsu-labs/diffguide/releases) also carries a `.vsix`.

## Requirements

| Requirement | Current support |
| --- | --- |
| VS Code | 1.100 or newer, trusted local workspace |
| Node.js | 22 or newer, available to Claude and its hooks |
| Git | Available on your computer |
| Claude Code | Installed, authenticated, with `asyncRewake` support |
| Operating system | macOS primary; Linux unverified; automatic connection blocked on Windows |

## Install the extension

1. In VS Code, open **Extensions**, search for **DiffGuide** and choose **Install**. To install a `.vsix` from [GitHub Releases](https://github.com/kaiketsu-labs/diffguide/releases) instead, choose **… → Install from VSIX…**.
2. Open your local Git repository in a trusted VS Code window.

VS Code also supports `code --install-extension /path/to/diffguide-VERSION.vsix`. See the [official VSIX installation instructions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#packaging-extensions).

## Connect Claude

Click **Connect Claude** on the local review page, or run **DiffGuide: Connect Claude** from the Command Palette. **Resume a conversation…** shows this project's recent conversations with names, branches and a **Running** indicator. Search by name or branch; **All conversations…** opens Claude's own picker. **New conversation** starts a fresh conversation. The launcher never silently chooses the latest session.

For a conversation already running in the project, choose **Connect running Claude** on the page, or **Connect running Claude** in the Command Palette. With Claude Code **2.1.280+**, DiffGuide installs a local plugin using Claude's plugin manager. In the intended conversation, run the two commands the page menu (or, from the Command Palette, a small setup view) shows: `/reload-plugins --force`, then `/diffguide:connect`. Copy buttons avoid typing. The original process and conversation remain active; the reload rereads conversation context once. Wait for **Feedback on**. This flow works independently of the terminal's location; the authenticated walkthrough currently covers the integrated terminal.

The previous/new choices start Claude in an integrated terminal with the review connection attached. Complete normal Claude trust or tool-permission prompts. An arbitrary terminal is never attached just because it happens to be open. Running conversations must be in this project's root directory and explicitly connected; a ticket expires after 15 minutes, after which the setup action can be run again.

After an update, reload the VS Code window and reconnect Claude once so it loads the new helpers. A normal window reload recognizes this project's existing **Claude · DiffGuide** terminal. **Show terminal** reopens it. **Switch conversation** (or **Restart connection** when delivery is inactive) explicitly replaces that managed terminal after you choose existing/new; cancelling or failing setup keeps it intact. External terminals are never closed by this action. If another receiver is active without a managed terminal, the launcher asks you to exit it first; readiness expires within 45 seconds.

### Use a separate terminal

Run **DiffGuide: Copy connect command** from the Command Palette. Choose **Resume a conversation** or **New conversation**, then paste at a shell prompt in Terminal, iTerm or another local terminal. If Claude is running there, use `/exit` first. The command changes to the project folder and starts Claude with the same private review configuration as the integrated launcher. Copying does not start or stop a session. Keep this project's VS Code window open, and use only one review receiver for the project.

Claude's usual project configuration and tool approvals still apply. The generated command does not force a model, remove other MCP servers or bypass permissions. A copied command preserves the current live-session selection until execution and refuses to clear a different, subsequently selected session. Custom options supplied only to the old Claude invocation must be supplied again on resume; see [Claude session restoration](https://code.claude.com/docs/en/sessions#what-a-resumed-session-restores).

The **Connect Claude** button on the review page shows whether the connection is live. A ready connection still does not mean Claude has acknowledged an individual comment.

## Leave your first comment

Open the **Local** view in the DiffGuide sidebar and click **Review local changes** on a checkout row. The review page lists your uncommitted changes and new files against HEAD. Click a line number, or drag across several, write your feedback and choose **Ask** to discuss it or **Implement** to request a change. Typing alone does not send anything.

Right-click a file in the Explorer and choose **Show in DiffGuide** to see it there. A file without changes opens whole, marked **Not changed**, and stays while it has open threads.

Each comment keeps the code it was written on. Claude's replies appear in the same thread, with code in syntax-colored blocks. Cmd/Ctrl-click a name in the diff to peek at its definition; **Open in editor** opens the file.

Wait for Claude's reply. **Resolve** closes a thread when you accept it and **Reopen** continues it. The page updates when files change on disk.

## If the connection needs attention

| Symptom | What to try |
| --- | --- |
| Claude or Node cannot be found | Set **DiffGuide: Claude Path** or **DiffGuide: Node Path** to the full executable path. |
| Multiple Claude installations | Set the Claude path explicitly; different terminals may resolve different versions. |
| Running connection reports an old Claude version | Use Claude Code 2.1.280+ and set `diffGuide.claudePath` to that installation. Trusted workspace settings may override both executable paths. |
| `/diffguide:connect` is unknown | Run `/reload-plugins --force` in the intended conversation after preparing the connection in VS Code. Check local plugin policy if installation failed. |
| Another conversation is selected | Finish or `/exit` the old receiver, allow up to 45 seconds for readiness to expire, then prepare the desired connection in VS Code. Automatic takeover is refused. |
| Claude has exited but the terminal remains | Run **Connect Claude** again. Use **Restart connection** when offered. |
| A comment remains waiting | Open the connected terminal and check Claude's startup and tool approval prompts. A live bridge is not proof that Claude acknowledged the event. |
| Repeated “Stop hook feedback” | Update the extension and reconnect Claude once. Normal hook rearming remembers events already announced in that session. Starting/resuming a session intentionally recovers unfinished work. The generic hook heading belongs to Claude Code; the message beneath it identifies the feedback. |
| More than 24 hours of idle time | Reconnect or send a prompt to Claude to rearm the watcher. |
| Context has changed | Open the thread. A saved excerpt is used when the original location cannot be matched safely. |

Keep **DiffGuide: Transport** set to **hooks** for the default connection. The optional **channels** mode uses Claude's development-channel interface and depends on account availability, organization policy, and startup confirmation. Choose it before connecting a new session.

For unresolved problems, [open an issue](https://github.com/kaiketsu-labs/diffguide/issues/new/choose) with your extension, VS Code, Node, and Claude versions plus reproducible steps. Remove credentials and private code from logs before sharing them.

## Moving from Pair Review

DiffGuide is a new extension with the ID `kaiketsu-labs.diffguide`, so VS Code does not update Pair Review to it.

- Uninstall Pair Review, then install DiffGuide.
- Settings moved from `pairReview.*` to `diffGuide.*`, and commands from `pairReview.*` to `diffGuide.*`. Rename your settings, keybindings and theme color overrides (`pairReview.selectionBackground`, `pairReview.selectionBorder`) by hand.
- Side-composer drafts, comment window contrast, pinned and hidden PRs, and seen Claude answers start fresh.
- Local review threads in plain workspaces start empty.
- PR worktrees under `.claude/worktrees/pair-review/` move to `.claude/worktrees/diffguide/`, with their threads, the first time you open each PR.
- DiffGuide updates the handoff comments Pair Review posted on GitHub instead of adding new ones.
- In Claude, run `/diffguide:connect`. Setup removes the old Pair Review plugin.
