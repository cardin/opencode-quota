[← Back to README](../../README.md)

# Manual install

The guided installer is easier and safer:

```bash
npx @slkiser/opencode-quota@latest init
```

Use this guide only if you want to edit OpenCode files yourself.

## Choose where to install

- **Global:** works in every project. Files live in `~/.config/opencode` on every OS (`$XDG_CONFIG_HOME/opencode` when `XDG_CONFIG_HOME` is set).
- **Project:** works only in the current repo or worktree.
- **Custom:** if `OPENCODE_CONFIG_DIR` is set, OpenCode uses that directory instead of the global one.

Use `.jsonc` files if you want comments. Use `.json` files if another tool requires strict JSON.

## 1. Add the plugin

Add OpenCode Quota to `opencode.jsonc` or `opencode.json`. This one entry loads both the server plugin and the TUI; no `tui.json` entry is needed:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@slkiser/opencode-quota"],
}
```

Keep any existing plugins and settings.

## 2. Add quota settings

Create `opencode-quota/quota-toast.jsonc` beside the OpenCode config for your chosen scope:

```jsonc
{
  // Find providers from OpenCode configuration and authentication.
  "enabledProviders": "auto",

  // Show the detailed Quota panel in the TUI sidebar.
  "tuiSidebarPanel": {
    "enabled": true,
  },

  // Keep the other automatic TUI displays off.
  "enableToast": false,
  "tuiCompactStatus": {
    "enabled": false,
  },

  // Show a one-time count of bundled maintainer notices after the first quota toast.
  "maintainerAnnouncements": {
    "enabled": true,
    "home": true,
  },
}
```

Use `quota-toast.json` instead if you need strict JSON. Remove the comments and trailing commas.

Restart OpenCode, then run in the TUI:

```text
/quota
/quota_status
```

`/quota_status` shows the exact files OpenCode Quota loaded.

## Change what appears in the TUI

Put these settings in `quota-toast.jsonc`.

| You want                    | Setting                                  |
| --------------------------- | ---------------------------------------- |
| Sidebar panel               | `tuiSidebarPanel.enabled: true`          |
| Popup quota notifications   | `enableToast: true`                      |
| Compact quota line          | `tuiCompactStatus.enabled: true`         |
| Quota bar under the prompt  | `tuiPromptBar.enabled: true`             |
| Manual slash commands only  | Disable sidebar, toast, and compact line |

TUI slash commands open the report in a popup; set `tuiCommandDisplay: "inline"` to keep it in the chat instead. Web and Desktop show none of the settings above.

See [Configuration](configuration.md) for more examples and every setting.

## Web and Desktop notes

- On Web and Desktop, `/quota` posts the report in the chat as your message. The AI never answers it, and the plugin filters it out of every AI request. If you uninstall the plugin, old reports in past chats are no longer filtered.
- Each report starts with `[OpenCode Quota report]` and ends with `[End of OpenCode Quota report]`. These lines keep the report out of compaction summaries too.
- Web shows chat messages in a proportional font, so report columns may not line up. For aligned columns, use the TUI or run `npx @slkiser/opencode-quota show` in a terminal.
- If the AI is working when you run a command, the report appears after the AI finishes.
- A new session whose first message is a report keeps its default title.

## Update safely

Close OpenCode, preview the update, then apply it:

```bash
npx @slkiser/opencode-quota@latest update --dry-run
npx @slkiser/opencode-quota@latest update
```

The updater preserves unrelated settings, comments, and plugins where targeted editing is safe. Its preview can include recognized file-backed display migration and report-only credential findings; it never moves or deletes secrets. Restart OpenCode when it finishes. See [Updating safely](updating.md) for the complete workflow.
