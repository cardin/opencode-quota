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

TUI slash commands always open a dialog. Web and Desktop show none of the settings above.

See [Configuration](configuration.md) for more examples and every setting.

## Web and Desktop notes

- Web and Desktop list the same slash commands. The result appears as a one-line notice in the session, cut off at the window edge. For the full report, run `npx @slkiser/opencode-quota show` in a terminal, or ask the assistant to run its `quota_status` tool.
- The assistant never sees these notices: OpenCode Quota removes them from every model request. They stay in the session history.
- Known limitation: when OpenCode compacts a long session, a recent notice can leave one short placeholder line (`[OpenCode Quota slash command output...]`) in the summary. The report itself is never included.
- The TUI `/` menu lists each quota command twice: one opens the dialog, the other is the Web and Desktop version and adds a notice to the session.

## Update safely

Close OpenCode, preview the update, then apply it:

```bash
npx @slkiser/opencode-quota@latest update --dry-run
npx @slkiser/opencode-quota@latest update
```

The updater preserves unrelated settings, comments, and plugins where targeted editing is safe. Its preview can include recognized file-backed display migration and report-only credential findings; it never moves or deletes secrets. Restart OpenCode when it finishes. See [Updating safely](updating.md) for the complete workflow.
