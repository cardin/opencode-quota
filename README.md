<p align="center">
  <a href="https://github.com/slkiser/opencode-quota">
    <picture>
      <source srcset="https://shawnkiser.com/opencode-quota/opencode-quota-logo-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="https://shawnkiser.com/opencode-quota/opencode-quota-logo-light.svg" media="(prefers-color-scheme: light)">
      <img src="https://shawnkiser.com/opencode-quota/opencode-quota-logo-light.svg" alt="OpenCode Quota logo">
    </picture>
  </a>
</p>
<p align="center">Quota, usage, and token visibility in OpenCode and your terminal.</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@slkiser/opencode-quota"><img alt="npm" src="https://img.shields.io/npm/v/%40slkiser%2Fopencode-quota?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/@slkiser/opencode-quota"><img alt="npm downloads" src="https://img.shields.io/npm/dm/%40slkiser%2Fopencode-quota?style=flat-square" /></a>
  <a href="https://github.com/slkiser/opencode-quota/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/slkiser/opencode-quota/ci.yml?style=flat-square&branch=main&label=CI" /></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" /></a>
</p>

> [!TIP]
> **Like this plugin?** A 👍 on [opencode#38281](https://github.com/anomalyco/opencode/issues/38281) helps get it listed, and [#43132](https://github.com/anomalyco/opencode/issues/43132) asks for Web/Desktop panels.

[![OpenCode Quota sidebar](https://shawnkiser.com/opencode-quota/opencode-quota-sidebar.webp)](https://github.com/slkiser/opencode-quota)

---

## Quick start

```bash
npx @slkiser/opencode-quota init
```

> [!IMPORTANT]
> Requires OpenCode `2.0.16` or newer. On OpenCode 1? Use `npx @slkiser/opencode-quota@4 init`. Node.js `22.13+` is required for `npx @slkiser/opencode-quota ...` (on Node 23, `23.4+`).

Upgrading from 4.x? Read [what changed in 5.0](#breaking-changes-in-500).

> [!NOTE]
> **Try the 5.0 beta.** Until 5.0.0 ships, the plain command installs 4.x. Run `npx @slkiser/opencode-quota@next init`, or put `"plugin": ["@slkiser/opencode-quota@next"]` in `opencode.json`. `npx @slkiser/opencode-quota@next update` keeps you on `@next`.

After installation:

1. Restart OpenCode.
2. Run `/quota` in the OpenCode TUI, or `opencode-quota show` in a terminal while OpenCode is running.
3. If you enabled the sidebar, open the session sidebar and look for `Quota`.
4. If you enabled the compact status line, look at the bottom of Home or below the message input.

## Updating

1. Close OpenCode.
2. Preview the update:

   ```bash
   npx @slkiser/opencode-quota@latest update --dry-run
   ```

3. Inspect the safe setting/cache changes and manual credential findings, then apply:

   ```bash
   npx @slkiser/opencode-quota@latest update
   ```

4. Restart OpenCode.

The updater always shows a preview first. `--yes` applies only the safe edits it previewed, and it never moves or deletes secrets. See [Updating safely](docs/readme/updating.md).

### Breaking changes in 5.0.0

> [!WARNING]
> - OpenCode 1 is no longer supported. `init` and `update` detect OpenCode 1 and keep you on 4.x (`@slkiser/opencode-quota@4`).
> - Logins come only from OpenCode 2's `opencode.db`, never `auth.json`. If a provider is missing, log in again.
> - Web and Desktop get the slash commands (report posts in the chat) but no toasts or panels.
> - One `"plugin"` entry in `opencode.json` loads the server and the TUI; no `tui.json` entry is needed.
> - TUI slash reports now open in a popup. Set `tuiCommandDisplay: "inline"` to keep them in the chat.
> - OpenCode Zen uses your OpenCode Console sign-in (`opencode auth login opencode`); the copied Console cookie file is no longer read. See [OpenCode Zen setup](docs/readme/providers.md#opencode-zen).
>
> Details: [Moving to OpenCode 2](docs/readme/updating.md#moving-to-opencode-2).

## Choose your setup

<table>
  <tr>
    <td width="50%">
      <img src="https://shawnkiser.com/opencode-quota/opencode-quota-sidebar.webp" alt="OpenCode Quota TUI sidebar panel" />
    </td>
    <td width="50%">
      <img src="https://shawnkiser.com/opencode-quota/opencode-quota-toast.webp" alt="OpenCode Quota popup toast" />
    </td>
  </tr>
  <tr>
    <td width="50%" align="center"><strong>Sidebar panel</strong><br />A full quota view in OpenCode's session sidebar.</td>
    <td width="50%" align="center"><strong>TUI toast</strong><br />Quota checks can appear automatically while you work.</td>
  </tr>
  <tr>
    <td width="50%">
      <img src="https://shawnkiser.com/opencode-quota/opencode-quota-statusbar.webp" alt="OpenCode Quota TUI status line" />
    </td>
    <td width="50%">
      <img src="https://shawnkiser.com/opencode-quota/opencode-quota-tokens-command.webp" alt="OpenCode Quota token report" />
    </td>
  </tr>
  <tr>
    <td width="50%" align="center"><strong>Compact status line</strong><br />Short quota text on Home and below the message input.</td>
    <td width="50%" align="center"><strong>Token reports</strong><br /><code>/tokens_today</code>, <code>/tokens_weekly</code>, session reports, and more.</td>
  </tr>
</table>

More ways to use it:

- **Terminal:** run `npx @slkiser/opencode-quota show` while OpenCode is running; it asks OpenCode's background service and exits with code `3` if OpenCode is not running. In Web and Desktop, slash commands post the report in the chat, and the AI can call the `quota_status` tool.
- **Several logins:** each login for a provider gets its own rows; `*` marks the active one.
- **Scripts and CI:** JSON output and optional OpenTelemetry metrics. See [External integration](docs/readme/external-integration.md).
- **Display:** a quota bar under the prompt ([`tuiPromptBar.enabled`](docs/readme/configuration.md#tui-settings)), OpenCode Go's collapsed-sidebar row ([`tuiSidebarPanel.opencodeGoPreferredWindow`](docs/readme/configuration.md#tui-settings)), reset countdown style ([`resetTimeSpaced`](docs/readme/configuration.md#common-changes), [`resetTimeDecimals`](docs/readme/configuration.md#common-changes)), bare `81%` labels ([`percentLabelStyle`](docs/readme/configuration.md#common-changes)), and extra accounting rows ([`accountingDetail`](docs/readme/configuration.md#show-accounting-detail)).
- **Runs-out estimate:** [`quotaProjection: "runway"`](docs/readme/configuration.md#estimate-when-fixed-quota-runs-out) shows **Runs out ≈ 1h 50m** for supported fixed windows. Off by default; JSON is unchanged.
- **Tokens and resets:** include subagent sessions with [`sessionTokenScope: "tree"`](docs/readme/configuration.md#include-subagent-session-tokens); get a popup when quota comes back with [`resetNotifications`](docs/readme/configuration.md#notify-when-quota-becomes-available-again).
- **Troubleshooting:** `/quota_status` checks logins, quota sources, pricing, and maintainer notices.

See [Configuration](docs/readme/configuration.md) for UI options and [Manual install](docs/readme/manual-install.md) for setup details.

## Commands

### Core slash commands

Type these in OpenCode. Add arguments after the command, like `/tokens_between 2026-09-01 2026-09-25`. See [Web and Desktop notes](docs/readme/manual-install.md#web-and-desktop-notes).

| Command                                 | Use when                                                        |
| --------------------------------------- | --------------------------------------------------------------- |
| `/quota`                                | Show current quota                                              |
| `/quota_status`                         | Diagnose setup, authentication, providers, pricing, and notices |
| `/quota_announcements`                  | Read active bundled maintainer notices                          |
| `/pricing_refresh`                      | Refresh local runtime pricing from `models.dev`                 |
| `/tokens_today`                         | Show tokens used today                                          |
| `/tokens_daily`                         | Show tokens used in the last 24 hours                           |
| `/tokens_weekly`                        | Show tokens used in the last 7 days                             |
| `/tokens_monthly`                       | Show tokens used in the last 30 days, including pricing         |
| `/tokens_all`                           | Show tokens used across all local history                       |
| `/tokens_session`                       | Show tokens used in the current session                         |
| `/tokens_session_all`                   | Show current session plus descendant sessions                   |
| `/tokens_between YYYY-MM-DD YYYY-MM-DD` | Show tokens used between two dates                              |

### CLI commands

Use the CLI for setup, updates, terminal checks, and custom providers.

| Command                                                  | What it does                                |
| -------------------------------------------------------- | ------------------------------------------- |
| `npx @slkiser/opencode-quota@latest init`                | Set up OpenCode Quota                       |
| `npx @slkiser/opencode-quota@latest provider add`        | Add or update a custom provider             |
| `npx @slkiser/opencode-quota@latest show`                | Show current quota                          |
| `npx @slkiser/opencode-quota@latest status`              | Check configuration and provider problems  |
| `npx @slkiser/opencode-quota@latest update`              | Update an existing installation             |

`show` and `status` need OpenCode running: they ask its background service, using your global quota settings. If OpenCode is not running, they exit with code `3`. Run `npx @slkiser/opencode-quota@latest --help` for command options. See [External integration](docs/readme/external-integration.md#1-get-json-from-a-command) for JSON, scripts, and CI examples.

## Providers

### Pre-configured American providers

<details open>
<summary><strong>Personal</strong></summary>

| Provider           | Auth/setup                                                     | Data from          | Reports            |
| ------------------ | -------------------------------------------------------------- | ------------------ | ------------------ |
| Anthropic (Claude) | [Needs setup](docs/readme/providers.md#anthropic-claude)       | Local CLI/OAuth    | Quota              |
| Chutes AI          | Automatic                                                      | Remote API         | Quota              |
| Cursor             | [Needs setup](docs/readme/providers.md#cursor)                 | Local estimate     | Budget and spend   |
| GitHub Copilot     | Automatic                                                      | Remote API         | Budget and usage   |
| Google AGY         | [Needs setup](docs/readme/providers.md#google-agy-quick-setup) | Remote API         | Quota              |
| Kilo Gateway       | Automatic                                                      | Remote API         | Quota and balance  |
| NanoGPT            | Automatic                                                      | Remote API         | Quota and balance  |
| Ollama Cloud       | Automatic                                                      | Remote API         | Quota and usage    |
| OpenAI             | Automatic                                                      | Remote API         | Quota              |
| OpenCode Go        | Automatic                                                      | Remote API         | Quota              |
| OpenCode Zen       | Automatic                                                      | Remote API         | Budget and balance |
| OpenRouter         | Automatic                                                      | Remote API         | Budget and spend   |
| Synthetic          | Automatic                                                      | Remote API         | Quota              |
| xAI SuperGrok      | Automatic                                                      | Remote API         | Quota              |

</details>

<details>
<summary><strong>Business / Enterprise</strong></summary>

| Provider                | Auth/setup                                                     | Data from          | Reports            |
| ----------------------- | -------------------------------------------------------------- | ------------------ | ------------------ |
| Anthropic (Claude)      | [Needs setup](docs/readme/providers.md#anthropic-claude)       | Local CLI/OAuth    | Quota              |
| Chutes AI               | Automatic                                                      | Remote API         | Quota              |
| Cursor                  | [Needs setup](docs/readme/providers.md#cursor)                 | Local estimate     | Budget and spend   |
| Gemini CLI              | [Needs setup](docs/readme/providers.md#gemini-cli)             | Remote API         | Quota              |
| GitHub Copilot          | [Needs setup](docs/readme/providers.md#github-copilot)         | Remote API         | Budget and usage   |
| Google AGY              | [Needs setup](docs/readme/providers.md#google-agy-quick-setup) | Remote API         | Quota              |
| NanoGPT                 | Automatic                                                      | Remote API         | Quota and balance  |
| OpenAI                  | Automatic                                                      | Remote API         | Quota              |
| OpenCode Zen            | Automatic                                                      | Remote API         | Budget and balance |
| OpenRouter              | Automatic                                                      | Remote API         | Budget and spend   |
| Synthetic               | Automatic                                                      | Remote API         | Quota              |
| xAI SuperGrok           | Automatic                                                      | Remote API         | Quota              |

Gemini CLI works only with Gemini Code Assist Standard or Enterprise (organization) accounts. Personal Google users should use Google AGY.

</details>

### Pre-configured Chinese providers

<details open>
<summary><strong>Personal</strong></summary>

| Provider                      | Auth/setup                                                                   | Data from      | Reports            |
| ----------------------------- | ---------------------------------------------------------------------------- | -------------- | ------------------ |
| Alibaba Coding Plan           | Automatic                                                                    | Local estimate | Quota              |
| Alibaba Personal Token Plan   | [Needs setup](docs/readme/providers.md#alibaba-personal-token-plan)          | Official CLI   | Quota              |
| DeepSeek                      | Automatic                                                                    | Remote API     | Balance and status |
| Kimi Code                     | Automatic                                                                    | Remote API     | Quota              |
| Kimi Code (CN)                | Automatic                                                                    | Remote API     | Quota              |
| MiniMax Token Plan            | Automatic                                                                    | Remote API     | Quota              |
| MiniMax Token Plan (CN)       | Automatic                                                                    | Remote API     | Quota              |
| Xiaomi MiMo                   | [Needs setup](docs/readme/providers.md#xiaomi-mimo)                          | Dashboard API  | Quota and balance  |
| Z.ai Coding Plan              | Automatic                                                                    | Remote API     | Quota              |
| Zhipu Coding Plan             | Automatic                                                                    | Remote API     | Quota              |

</details>

<details>
<summary><strong>Business / Team</strong></summary>

| Provider                 | Auth/setup | Data from  | Reports |
| ------------------------ | ---------- | ---------- | ------- |
| Kimi Code                | Automatic  | Remote API | Quota   |
| Kimi Code (CN)           | Automatic  | Remote API | Quota   |
| MiniMax Token Plan       | Automatic  | Remote API | Quota   |
| MiniMax Token Plan (CN)  | Automatic  | Remote API | Quota   |
| Zhipu Coding Plan        | Automatic  | Remote API | Quota   |

These vendors offer team or business plans, but the current integrations report only the configured member API key rather than organization-wide usage.

</details>

### Custom providers

Add a provider that uses a remote quota API or tracks a local usage estimate:

```bash
npx @slkiser/opencode-quota@latest provider add
```

The guided setup previews the change before saving. See the [custom-provider guide](docs/readme/providers.md#custom-providers) for details.

## Troubleshooting

If quota or token data looks wrong:

1. Run `/quota_status` in the OpenCode TUI, or `opencode-quota status` from a terminal for the same diagnostics (OpenCode must be running). Use `opencode-quota show` for a quick quota glance.
2. Confirm the expected provider appears in the detected provider list. If it is missing, log in to it again in OpenCode 2.
3. Confirm companion auth plugins are before `@slkiser/opencode-quota` in `opencode.json`.
4. If token reports are empty, start OpenCode once so it creates `opencode.db`, then run a session with model usage.
5. Check [Troubleshooting](docs/readme/troubleshooting.md) for common symptoms and provider-specific fixes.

## Reference

Project guides:

- [Manual install](docs/readme/manual-install.md)
- [Configuration](docs/readme/configuration.md)
- [Providers](docs/readme/providers.md)
- [Troubleshooting](docs/readme/troubleshooting.md)
- [External integration](docs/readme/external-integration.md)
- [Updating safely](docs/readme/updating.md)

External references:

- [OpenCode docs](https://opencode.ai/docs/)
- [OpenCode config](https://opencode.ai/docs/config/)
- [OpenCode plugins](https://opencode.ai/docs/plugins/)
- [OpenCode TUI](https://opencode.ai/docs/tui/)
- [models.dev pricing data](https://models.dev/)
- [Node.js downloads](https://nodejs.org/en/download)

## Contributors

Thanks to everyone who has contributed to OpenCode Quota.

<a href="https://github.com/slkiser/opencode-quota/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=slkiser/opencode-quota" />
</a>

## License

MIT

## Remarks

OpenCode Quota is not built by the OpenCode team and is not affiliated with OpenCode or any provider listed above.

## Star history

[![Star History Chart](https://api.star-history.com/svg?repos=slkiser/opencode-quota&type=date&legend=top-left)](https://www.star-history.com/#slkiser/opencode-quota&Date)
