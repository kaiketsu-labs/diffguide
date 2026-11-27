# Connecting Claude conversations

## Choose the conversation

Run **DiffGuide: Connect Claude** in the trusted project you want to review.

| Choice | Behavior |
| --- | --- |
| **Resume a conversation** | Search recent conversations from this exact project by name or branch. Named conversations retain their names; generated titles and first prompts are fallbacks. **Running** marks a live process. **All conversations…** opens Claude's own picker. |
| **New conversation** | Launch a fresh conversation with this project's feedback connection. |
| **Connect running Claude** | Install the local integration, then connect from inside the intended running conversation. A running row in the saved picker uses this flow too. |

The first two choices use VS Code's integrated terminal. **Copy connect command** provides the same new/resume launch for a separate terminal. Copying a command does not start or stop anything. It changes to the project directory when executed, passes review settings again and preserves ordinary Claude configuration and permissions. Additional flags from a previous invocation must be supplied again on resume. See [Claude session restoration](https://code.claude.com/docs/en/sessions#what-a-resumed-session-restores).

## Connect a running conversation

Choose **Connect running Claude** in VS Code, then execute the two copyable commands in the intended Claude terminal:

```text
/reload-plugins --force
/diffguide:connect
```

Requires **Claude Code 2.1.280 or newer**. The original process and conversation remain active. Loading the new tool set invalidates Claude's prompt cache, so the first command explicitly rereads the conversation context once. This is not a new conversation. The second command selects exactly the conversation in which it runs and arms automatic delivery. Wait for **Feedback on** in the setup view.

The connection works independently of whether Claude runs in an integrated or separate local terminal. Claude must be running at the same project root, with the same local configuration directory used by the setup CLI. Set `diffGuide.claudePath` if installations differ. Trusted workspace overrides are supported for both Claude and Node paths.

No terminal input is injected into an arbitrary conversation. The setup view copies only its two fixed commands. The user explicitly chooses where to execute them. The connection ticket expires after 15 minutes; repeat the VS Code setup action if it expires.

## Local setup and ownership

Claude's plugin manager registers a generated filesystem marketplace and enables its plugin with `--scope local`. Existing configuration is preserved; project enablement lives in `.claude/settings.local.json`. Plugin sources, private bridge credentials, selection metadata and tickets live in VS Code's workspace storage, outside the reviewed repository. No credentials belong in Git.

The plugin reuses DiffGuide's existing hooks and MCP tools. A local helper waits for saved feedback; the LLM does not repeatedly check for comments. A hook wakes Claude, and Claude acknowledges and answers through the plugin's namespaced tools. Readiness alone does not acknowledge a comment.

Only the selected session can receive or update feedback through the live plugin. The connect skill checks Claude's supplied identity against its runtime identity. Hooks, tools and the authenticated bridge all enforce the selection. Invalid selection metadata fails closed. A poll opened before a selection change is checked again before returning feedback.

An active receiver is never silently replaced. To switch away, finish or `/exit` it, allow up to 45 seconds for readiness to expire, then choose another connection. Copying a normal new/resume command keeps the existing selection intact; executing it releases only the owner captured by that command. A stale command refuses to clear a different selected session. External terminals are never killed by the extension.

After an extension update, reload VS Code and prepare/reconnect once to refresh installed helper paths. A normal bridge refresh rewrites the descriptor also used by an installed live plugin. For removal, exit the connected session, use Claude's plugin manager to uninstall the DiffGuide plugin for this project's **local** scope, then reload plugins in any remaining sessions. Do not remove unrelated plugins or existing Claude settings.
