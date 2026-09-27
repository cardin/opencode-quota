[← Back to README](../../README.md)

# Troubleshooting

Start with `/quota_status` inside OpenCode, or `opencode-quota status` from a terminal while OpenCode is running. Both show which config, providers, authentication, and local files OpenCode Quota found.

## First checks

1. Run `/quota_status` inside OpenCode. From a terminal, `opencode-quota status` shows the same report; it needs OpenCode running and uses your global quota settings.
2. Find the provider or feature that is failing.
3. Follow the matching fix below.
4. Restart OpenCode after changing config or authentication.

If every provider is missing, confirm OpenCode Quota is listed in `opencode.jsonc` or `.json`. That one entry also loads the TUI; no `tui.json` entry is needed.

OpenCode Quota asks OpenCode 2 for logins through its plugin API (OpenCode keeps them in `opencode.db`) and never reads `auth.json`. OpenCode 2 copies `auth.json` once, the first time it starts. If a provider is missing, log in to it again in OpenCode 2. In `/quota_status`, the `credential_source` section shows the login `source`, a `list_error` when OpenCode could not list logins, and `failures`: each login OpenCode could not return (for example a failed token refresh) as `provider:label:reason:detail`. Such a login also shows as an error row; log in to that provider again. `/quota_status` also shows the `opencode.db` path used for session and token history; `OPENCODE_DB` and `XDG_DATA_HOME` change it. Custom or source builds of OpenCode may use `opencode-<channel>.db` instead; set `OPENCODE_DB` to that file's path.

## Service environment

Every surface (TUI, Web, Desktop, and the terminal command) gets its numbers from OpenCode's background service. The service takes `PATH` and environment variables from whatever started it first, not from the terminal you use now, and it runs in your home folder.

- **`claude` or `bl` not found, or an API-key variable ignored:** in a terminal where they work, run `opencode service restart`. To keep that `PATH` for every later start, run `opencode service set env PATH "$PATH"` (it stops the service; open OpenCode again). For Claude you can instead set `anthropicBinaryPath`.
- A relative `export.path` is relative to your home folder.
- Cursor's plugin-entry check reads `opencode.json` in your global config folder and your home folder, not in the project folder.

## Common problems

| Problem                                                 | Try this                                                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slash commands are missing                              | Check the plugin entry above, then restart OpenCode.                                                                                              |
| `/quota` shows no providers                             | Run `/quota_status` or `opencode-quota status`, then check provider detection and authentication.                                                 |
| Sidebar is missing                                      | Confirm the plugin is installed and `tuiSidebarPanel.enabled` is `true`.                                                                          |
| Compact line is missing                                 | Confirm the plugin is installed and `tuiCompactStatus.enabled` is `true`.                                                                         |
| Compact line appears on Home only                       | Set `tuiCompactStatus.sessionPrompt` to `true`.                                                                                                   |
| TUI toast is missing                                    | Check `enableToast`, `showOnIdle`, `showOnQuestion`, and `showOnCompact`. Toasts appear only in the TUI.                                          |
| Token reports are empty                                 | Start OpenCode once, then use a model so `opencode.db` contains usage.                                                                            |
| Pricing looks old                                       | Run `/pricing_refresh`.                                                                                                                           |
| Web report columns do not line up                       | Expected: Web uses a proportional font. Use the TUI or run `npx @slkiser/opencode-quota show` in a terminal.                                      |
| Terminal command says `OpenCode is not running` (exit 3) | Open OpenCode or run `opencode service start`, then try again. The command never starts OpenCode itself.                                         |
| Terminal command says the server plugin is not loaded (exit 3) | Check the plugin entry above, then run `opencode service restart`.                                                                         |

## Update safely

1. Close OpenCode.
2. Preview the update:

   ```bash
   npx @slkiser/opencode-quota@latest update --dry-run
   ```

3. Inspect both safe changes and manual findings. Do not paste credential values into command output or issue reports.
4. Apply the plan:

   ```bash
   npx @slkiser/opencode-quota@latest update
   ```

5. Restart OpenCode.
6. Run `/quota_status` in OpenCode, or run `opencode-quota status` in a terminal.

The updater preserves unrelated settings, comments, and plugins where targeted editing is safe. Credential findings stay manual, and `--yes` authorizes only safe config/cache work. See [Updating safely](updating.md) for the complete workflow.

| Update result | What to do |
| --- | --- |
| Obsolete OpenCode Go source | Configure `OPENCODE_API_KEY`, trusted global `provider.opencode-go.options.apiKey`, fallback `provider.opencode.options.apiKey`, or `opencode auth login opencode-go`. Verify it, then manually remove the reported old variable/file. Workspace/cookie material cannot become an API key. |
| Old OpenCode Zen file or environment names | Run `opencode auth login opencode` and verify Zen works. Then remove the reported old `opencode-quota/opencode.json` file manually. Remove `OPENCODE_WORKSPACE_ID` / `OPENCODE_AUTH_COOKIE` only if they held Zen credentials; they may belong to OpenCode's workspace feature. Never paste the values into output or reports. |
| Unsupported display migration | Fix the reported invalid, duplicate, or ambiguous config manually. Use root `accountingDetail: "summary"` or `"detailed"`; do not share the rejected value. |
| Update race or partial-write failure | No package cache was deleted. Read the error's exact changed-path list, inspect those files, fix the cause, and rerun `update --dry-run` for a fresh plan. Do not restore over concurrent edits blindly. |

## Provider fixes

<details>
<summary><strong>Custom providers</strong></summary>

Run `/quota_status` and inspect `quota_providers`. Each definition shows its stable/provider IDs, mode, format or exact local state path, model coverage, live outcome, credential category, environment name, and safe checked paths. These results are fetched live for the status command; cached results are not substituted.

| Symptom                                    | Fix                                                                                                                                                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config is rejected                         | Run `opencode-quota provider add` and keep `quotaProviders` in global OpenCode JSONC/JSON. Remove `customSources`, unknown fields, duplicate IDs/request identities, or overlapping model coverage.  |
| Definition is `unavailable`                | Confirm OpenCode reports the exact configured `providerId`. With `onlyCurrentModel`, confirm the model id without provider prefix matches `modelIds`, or omit `modelIds` for provider-wide coverage. |
| `missing_credential`                       | Set the explicit `apiKeyEnv`, or configure trusted global `provider.<providerId>.options.apiKey`, or an API-key login saved in OpenCode 2 for that provider id.                                     |
| `http_error`, `timeout`, or response error | Check the endpoint service and response format. `/quota_status` intentionally hides URLs, request/response contents, raw errors, and secret material.                                                |
| One definition fails but others render     | This is expected partial-aggregate behavior. Successful definitions remain visible and the failed definition stays an error/status row.                                                              |
| Single-window output shows fewer rows      | Each source keeps only its lowest remaining percentage, or first value row. Use `"formatStyle": "allWindows"` for every row.                                                                         |
| CLI/export looks stale                     | `show --json` and the export file are cache-only and never fetch providers. Trigger a normal TUI/background refresh first. `/quota_status` is the live diagnostic surface.                           |

</details>

<details>
<summary><strong>Anthropic (Claude)</strong></summary>

Run `/quota_status` and check the Anthropic section.

| Symptom                              | Fix                                                                                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `claude` not found                   | Install Claude Code. OpenCode Quota tries `claude` on the [service `PATH`](#service-environment), then `~/.claude/local/claude`, `~/.local/bin/claude`, `/opt/homebrew/bin/claude`, and `/usr/local/bin/claude` (not on Windows). `binary_path` shows which one ran. |
| Claude is installed at a custom path | Set `anthropicBinaryPath` in `opencode-quota/quota-toast.json`.                                                                     |
| Not authenticated                    | Run `claude auth login`, then confirm `claude auth status` works.                                                                   |
| Auth works but no quota rows appear  | Check `quota_source` and `message` in `/quota_status`; re-authenticate Claude if the OAuth credential fallback is missing or stale. |
| Provider not detected                | Confirm OpenCode is configured to use the `anthropic` provider.                                                                     |

</details>

<details>
<summary><strong>GitHub Copilot</strong></summary>

Run `/quota_status` and check `copilot_quota_auth`, `deployment`, `api_host`, `enterprise_host_source`, `billing_model`, `billing_scope`, `quota_api`, `budget_api`, and `token_compatibility_error`.

| Symptom                                                  | Fix                                                                                                                                                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode Copilot works but no personal quota row appears | Check `oauth_accounting_state`, `deployment`, and `api_host`; re-authenticate Copilot in OpenCode if the OAuth token or its stored GHE.com host is invalid.                                                               |
| Organization or enterprise accounting is missing         | Create `copilot-quota-token.json` as described in [GitHub Copilot setup](providers.md#github-copilot). Public billing reports still need a separate billing credential.                                                   |
| GHE.com host is rejected                                 | Use the enterprise hostname (for example `acme.ghe.com`) or a host-only HTTPS URL. Do not enter `api.`, a path, query, fragment, port, userinfo, wildcard, HTTP URL, IP/localhost, or another domain.                     |
| Personal report is forbidden                             | Use a fine-grained PAT with **Plan: read** or a GitHub App user access token. A GitHub App installation token cannot query a personal report.                                                                             |
| Organization report or budget is forbidden               | Use an organization admin/billing-manager credential. Fine-grained PAT and GitHub App credentials need **Organization administration: read**. Usage can still appear with a budget warning when only budget access fails. |
| Enterprise report is forbidden                           | Use a classic PAT held by an enterprise admin or billing manager. GitHub does not support fine-grained PATs or GitHub App access tokens for enterprise billing reports.                                                   |
| Usage appears without a percentage                       | This is expected when GitHub supplies usage but no real allowance or positive budget denominator. opencode-quota does not invent a percentage.                                                                            |
| Legacy PRU config is rejected                            | Set `"billingModel": "legacy_premium_requests"` only for an existing annual Copilot Pro or Pro+ plan that remained on legacy billing after June 1, 2026.                                                                  |
| Rate-limit error                                         | Wait for GitHub's REST API rate limit to reset, then run `/quota` again.                                                                                                                                                  |

</details>

<details>
<summary><strong>OpenAI</strong></summary>

Run `/quota_status` and check the OpenAI auth source and token status.

| Symptom               | Fix                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------ |
| OpenAI quota missing  | Sign in to OpenAI in OpenCode 2: `opencode auth login openai`.                             |
| `OpenAI sign-in could not be refreshed` | OpenCode could not refresh the token. Run `opencode auth login openai`. For xAI, the row says `xAI sign-in could not be refreshed`; run `opencode auth login xai`. |
| Provider not detected | Confirm your OpenCode config uses the `openai` provider or a compatible OpenAI auth entry. |

</details>

<details>
<summary><strong>Cursor</strong></summary>

Run `/quota_status` and check the Cursor section.

| Symptom                                   | Fix                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Cursor not detected                       | Put `cursor-opencode-provider/plugin/opencode2` before `@slkiser/opencode-quota` in `opencode.json`.    |
| Cursor auth missing                       | Run `/connect` → **Cursor** in OpenCode, or set `CURSOR_API_KEY`.                                       |
| Quota appears but no remaining percentage | Set `cursorPlan` or `cursorIncludedApiUsd` in `opencode-quota/quota-toast.json`.                        |
| Billing cycle looks wrong                 | Set `cursorBillingCycleStartDay` in `opencode-quota/quota-toast.json` to your local billing anchor day. |
| Unknown Cursor pricing                    | Run `/pricing_refresh`; if still unknown, check `/quota_status` for unknown model ids.                  |

</details>

<details>
<summary><strong>Alibaba Coding Plan</strong></summary>

Run `/quota_status` and check the Alibaba auth, resolved tier, state-file path, and `alibaba_coding_plan` live probe section.

| Symptom              | Fix                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API key not detected | Use `ALIBABA_CODING_PLAN_API_KEY`, `ALIBABA_API_KEY`, trusted user/global OpenCode config, or OpenCode auth. Repo-local provider secrets are ignored.              |
| Limits need tuning   | Run `opencode-quota provider add`, choose local estimate, and use the maintained `alibaba-coding-plan` id with its five-hour, weekly, and monthly rolling windows. |
| Counters do not move | Confirm the current model is `alibaba/*` or `alibaba-cn/*`.                                                                                                        |
| Quota seems stale    | Check the state-file path shown in `/quota_status`.                                                                                                                |

</details>

<details>
<summary><strong>Alibaba Personal Token Plan</strong></summary>

Run `/quota_status` and check the `alibaba_token_plan` live probe. This source is separate from Alibaba Coding Plan API-key diagnostics.

| Symptom                 | Fix                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI not detected        | Install official `bailian-cli` so `bl` is in an absolute directory on the [service `PATH`](#service-environment) that is not inside the project folder (for example `/opt/homebrew/bin`, `~/.local/bin`, or an nvm folder). Relative `PATH` entries are ignored. On Windows, run this from WSL. Native `bl.exe` and `.cmd` shims are not supported. |
| Console session expired | Run `bl auth login --console`. A Coding Plan API key cannot authenticate this provider.                                                                             |
| Weekly row only         | The official CLI may omit the five-hour window. OpenCode Quota does not invent a missing window.                                                                    |
| JSON export empty       | `show --json` is cache-only. This provider is uncached, so a separate CLI process reports it unavailable instead of running `bl`.                                   |

</details>

<details>
<summary><strong>MiniMax, Kimi, Chutes AI, Synthetic, Z.ai, Zhipu, NanoGPT, DeepSeek, and OpenRouter</strong></summary>

These providers use trusted env vars, trusted user/global OpenCode config, or native OpenCode auth. Run `/quota_status` and check the provider-specific API-key diagnostics.

| Provider                 | Useful checks                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MiniMax Token Plan       | Use `MINIMAX_CODING_PLAN_API_KEY` or `MINIMAX_API_KEY` for the international endpoint. Runtime/config ids like `minimax` and `minimax-coding-plan` use this provider. Repo-local provider secrets are ignored.                        |
| MiniMax Token Plan (CN)  | Use `MINIMAX_CHINA_CODING_PLAN_API_KEY` or trusted user/global OpenCode config under `minimax-china-coding-plan`, `minimax-cn-coding-plan`, `minimax-cn`, or `minimax-china`. Runtime id `minimax-cn-coding-plan` uses this provider. |
| Kimi Code                | Check `kimi:`. Use `KIMI_GLOBAL_API_KEY`, trusted global `provider.kimi-code-plan-global.options.apiKey`, or strict `kimi-code-plan-global` auth. Requests go only to `api.kimi.ai`; repo-local secrets are ignored.                     |
| Kimi Code (CN)           | Check `kimi_cn:`. Use `KIMI_CN_API_KEY`, then `KIMI_API_KEY` or `KIMI_CODE_API_KEY`, or trusted CN/legacy config/auth ids. Requests go only to `api.kimi.com`; repo-local secrets are ignored.                                          |
| Chutes AI                | Use `CHUTES_API_KEY`, trusted user/global config, or OpenCode auth.                                                                                                                                                                   |
| Synthetic                | Use `SYNTHETIC_API_KEY`, trusted user/global config, or OpenCode auth.                                                                                                                                                                |
| Z.ai Coding Plan         | Use `ZAI_API_KEY` or `ZAI_CODING_PLAN_API_KEY`; malformed fallback auth is surfaced as an auth error.                                                                                                                                 |
| Zhipu Coding Plan        | Use `ZHIPU_API_KEY` or `ZHIPU_CODING_PLAN_API_KEY`; malformed fallback auth is surfaced as an auth error.                                                                                                                             |
| NanoGPT                  | Use `NANOGPT_API_KEY`, `NANO_GPT_API_KEY`, trusted user/global config, or OpenCode auth.                                                                                                                                              |
| DeepSeek                 | Use `DEEPSEEK_API_KEY`, trusted user/global config under `provider.deepseek.options.apiKey`, or OpenCode auth. This provider shows balance only because DeepSeek does not expose a quota reset window.                                |
| OpenRouter               | Use `OPENROUTER_API_KEY`, trusted user/global config, or OpenCode auth. `/quota_status` has an `openrouter:` section with the trusted key source and the live probe, including errors such as HTTP 401.                               |

If Synthetic is authenticated and the quota endpoint returns HTTP 200 `{}`, `/quota` and `/quota_status` report `Synthetic returned no quota data for this account.` That is not an invalid API key or a Clerk/browser requirement. The plugin does not invent 5h or Weekly rows. `/quota_status` shows it on `live_error_*`.

For security, repo-local `opencode.json` / `opencode.jsonc` is ignored for provider secrets in these integrations. Put secrets in environment variables or trusted user/global config. OpenCode auth fallbacks for API-key providers must be API-key logins, not OAuth sign-ins.

</details>

<details>
<summary><strong>Google AGY</strong></summary>

Run `/quota_status` and check the `google_agy` section.

| Symptom                             | Fix                                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| Companion missing                   | Put `@anthonyhaussman/opencode-agy-auth` before `@slkiser/opencode-quota` in `opencode.json`. |
| Provider not enabled in manual mode | Include `google-agy` in `enabledProviders` in `opencode-quota/quota-toast.json`.              |
| Auth missing                        | Run `opencode auth login google-agy`.                                                         |
| Project missing                     | Set `OPENCODE_AGY_PROJECT_ID` or `provider.google-agy.options.projectId`.                     |
| Provider returns no rows            | Check `live_probe`, `live_entry_*`, and `live_error_*` in `/quota_status`.                    |

</details>

<details>
<summary><strong>Gemini CLI</strong></summary>

Gemini CLI works only with Gemini Code Assist Standard or Enterprise (organization) accounts. Google ended personal accounts on 2026-06-18, so personal Google users should use [Google AGY](providers.md#google-agy-quick-setup) instead.

Run `/quota_status` and check the Gemini CLI live probe rows.

| Symptom                             | Fix                                                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Companion missing                   | Put `opencode-gemini-auth` before `@slkiser/opencode-quota` in `opencode.json`.                                              |
| Provider not enabled in manual mode | Include `google-gemini-cli` in `enabledProviders` in `opencode-quota/quota-toast.json`.                                      |
| Auth missing                        | Run `opencode auth login google`.                                                                                            |
| Project missing                     | Set `provider.google.options.projectId`, `OPENCODE_GEMINI_PROJECT_ID`, `GOOGLE_CLOUD_PROJECT`, or `GOOGLE_CLOUD_PROJECT_ID`. |

</details>

<details>
<summary><strong>Xiaomi MiMo</strong></summary>

Run `/quota_status` and check the `xiaomi` section. Diagnostics show state, source, checked paths, and safe live summaries, never cookie names, cookie values, or raw responses.

| Symptom                             | Fix                                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Config not detected                 | Set `MIMO_USAGE_COOKIE` or create trusted user/global `opencode-quota/mimo.json`, then rerun `/quota_status`.                           |
| Config is invalid                   | Fix or remove the reported higher-priority source; invalid sources intentionally block fallback.                                        |
| Provider not enabled in manual mode | Include canonical `xiaomi` in `enabledProviders`.                                                                                       |
| Monthly quota missing               | Confirm the plan is active and check `live_error_*`; explicitly expired plans are hidden.                                               |
| Balance or plan details missing     | Check the partial live summary. Usage, detail, and balance requests fail independently, so other available rows can still appear.       |
| Per-key costs missing               | Per-API-key cost accounting is not supported until Xiaomi provides endpoint and schema evidence.                                        |
| Session expired                     | Sign in again at `platform.xiaomimimo.com`, manually copy a fresh request Cookie header, and update the same trusted credential source. |

</details>

<details>
<summary><strong>OpenCode Go</strong></summary>

Run `/quota_status` and check the `opencode_go` section. It reports safe `auth_*` diagnostics, the selected display windows, normalized API usage, and `live_fetch_error` without exposing the API key. When you are signed in to the OpenCode Console, `console_auth_state` and `console_server` describe that sign-in, `go_source` shows whether the Console (`console`) or the API key (`legacy_key`) answered, and `console_error` shows why the Console failed. `opencode_go_state: not_subscribed` means the Console reports no Go subscription (for example HTTP 404 from `/api/go/status`). An HTTP 403 is a failed Console request: Go uses the API key if one is set, otherwise it stays quiet with `console_error` set.

| Symptom                             | Fix                                                                                                                                                                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider not detected               | Sign in with `opencode auth login opencode`, or set `OPENCODE_API_KEY`, trusted global `provider.opencode-go.options.apiKey`, fallback `provider.opencode.options.apiKey`, an `opencode-go` API-key login (`opencode auth login opencode-go`), or a legacy `opencode` API-key login as the final fallback. Then check `auth_state`, `auth_source`, and `auth_checked_paths`. |
| `auth_state` is `invalid`           | Log in again with `opencode auth login opencode-go`. A broken `opencode-go` login blocks the legacy `opencode` fallback and is reported in `auth_error`.                    |
| `OpenCode Console sign-in failed` | Shown only when no API key is set. Run `opencode auth login opencode`, or set an API key. `console_error` has the reason. |
| No Go quota, `console_error` set    | The Console request failed (for example HTTP 403) and no API key is set, so Go shows no quota (`Not configured` in manual mode). Check `console_error` and retry, or set an API key. |
| API returns 401 or 403              | The usage API rejected the key. Update the winning source shown by `auth_source`, wait briefly for credential caching to expire, and rerun `/quota_status`.                                                           |
| Invalid API response                | Check `live_fetch_error`. OpenCode Quota requires valid 5h, Weekly, and Monthly results, so one missing or malformed API window rejects the full response instead of showing partial quota.                            |
| API request times out or fails      | Check `live_fetch_error`, confirm `https://opencode.ai/zen/go/v1/usage` is reachable, and retry. Increase `requestTimeoutMs` only when the error is a timeout.                                                          |
| Expected window is not displayed    | Check `selected_windows`, then update `opencodeGoWindows` in `opencode-quota/quota-toast.json`. This setting only filters the already validated 5h (`rolling`), Weekly (`weekly`), and Monthly (`monthly`) API results. |
| Provider missing in manual mode     | Include `opencode-go` in `enabledProviders` in `opencode-quota/quota-toast.json`.                                                                                                                                     |

</details>

<details>
<summary><strong>OpenCode Zen</strong></summary>

Run `/quota_status` and check the `opencode_zen` section. `console_auth_state` shows whether OpenCode returned your Console sign-in, `console_server` and `console_org` show which Console and organization Zen reads, and `budget_source` shows whether the monthly budget came from the org budget (`org_budget`) or the credit limit plus this month's usage (`credit_limit`). `live_fetch_error` lists failed Console routes. The token is never shown.

| Symptom | Fix |
| --- | --- |
| Zen does not appear | Run `opencode auth login opencode` and sign in to the Console. An OpenCode API key alone is not a Console sign-in. To see a hint instead of nothing, include `opencode` in `enabledProviders`. |
| `OpenCode Console sign-in failed` or `session expired or invalid` | Run `opencode auth login opencode` again. |
| Wrong organization | Run `opencode auth switch opencode` to pick another saved sign-in, or sign in again and pick the organization. Check `console_org`. |
| `OpenCode Console <route> error 403` | Your sign-in cannot read that route for this organization. Zen still shows the other rows, unless the route is `billing/status` (the balance). |

</details>

<details>
<summary><strong>Token reports</strong></summary>

Run `/quota_status` and check pricing snapshot health plus the `opencode.db` path.

| Symptom                                | Fix                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `/tokens_*` is empty                   | Start OpenCode once so it creates `opencode.db`, then run a session with model usage.                         |
| Pricing looks stale                    | Run `/pricing_refresh`.                                                                                       |
| Runtime pricing does not change output | Check `pricingSnapshot.source` in `opencode-quota/quota-toast.json`; `bundled` keeps packaged pricing active. |
| Cursor model has unknown pricing       | Run `/pricing_refresh`; Cursor `auto`, `composer*`, and `grok-4.5`–`grok-4.7` use bundled Cursor pricing.     |

</details>
