[← Back to README](../../README.md)

# Updating safely

## What the command does

`npx @slkiser/opencode-quota@latest update` first asks npm to resolve and run the published `@latest` CLI package. That npm resolution and execution begins before the updater can print its preview. The preview guarantee covers changes owned by the updater: OpenCode configuration files and OpenCode Quota package-cache directories.

The updater builds one plan, prints it in full, and then either stops or applies that same plan. It does not add runtime compatibility fallbacks.

## Preview, apply, and restart

1. Close OpenCode.
2. Preview without changing configuration or package caches:

   ```bash
   npx @slkiser/opencode-quota@latest update --dry-run
   ```

3. Read every section. If the plan is correct, apply it:

   ```bash
   npx @slkiser/opencode-quota@latest update
   ```

   The interactive command asks once before safe work begins. For a noninteractive run, use:

   ```bash
   npx @slkiser/opencode-quota@latest update --yes
   ```

   `--yes` still prints the full preview. It authorizes only deterministic config edits and manifest-verified cache cleanup, never secret changes.

4. Restart OpenCode.
5. Run `/quota_status` in OpenCode, or run this in a terminal:

   ```bash
   opencode-quota status
   ```

## Moving to OpenCode 2

`5.0.0` runs only on OpenCode `2.0.16` or newer.

1. Install OpenCode 2 ([OpenCode docs](https://opencode.ai/docs/)) and start it once. On first start it copies your old `auth.json` logins into its database, `opencode.db`. It does this only once.
2. Run the update steps above.
3. Run `/quota_status` in the OpenCode TUI. If a provider you use is missing, log in to it again in OpenCode 2 (`/connect`, or `opencode auth login <provider>`). OpenCode Quota never reads `auth.json`.

What changed in `5.0.0`:

- **OpenCode 1 is no longer supported.** `init` and `update` detect OpenCode 1 and keep you on 4.x. See [OpenCode 1](#opencode-1).
- **Logins come only from OpenCode 2.** OpenCode Quota asks OpenCode 2 for logins through its plugin API (OpenCode keeps them in `opencode.db`) and never reads `auth.json`. OpenCode 2 copies your old logins once, the first time it starts. If a provider is missing, log in again in OpenCode 2.
- **Quota is computed in OpenCode's background service.** `PATH`, environment variables, and the working folder (your home folder) come from the service, not from your terminal. See [Service environment](troubleshooting.md#service-environment).
- **Web and Desktop have slash commands but no toasts or panels,** because OpenCode 2 gives plugins no Web UI hooks. On Web and Desktop, `/quota` posts the report in the chat as your message. The AI never answers it, and the plugin filters it out of every AI request. If you uninstall the plugin, old reports in past chats are no longer filtered. See [Web and Desktop notes](manual-install.md#web-and-desktop-notes).
- **One plugin entry.** One `"plugin"` entry in `opencode.json` loads both the server and the TUI; no `tui.json` entry is needed.
- **TUI reports open in a popup.** TUI slash commands and the command palette open the report in a popup and leave no chat message. `tuiCommandDisplay` now defaults to `"dialog"`; set `"inline"` to keep TUI slash reports in the chat instead.
- **Removed setting.** `tuiCompactStatus.suppressWhenNativeProviderQuota` was removed; the old key is ignored.

## OpenCode 1

`init` and `update` run `opencode --version` first.

- **OpenCode 2:** they work as described on this page.
- **OpenCode 1:** `init` stops without changing anything and tells you to run `npx @slkiser/opencode-quota@4 init`. `update` keeps you on 4.x: its preview proposes pinning bare, `@latest`, `@next`, and exact-version quota specs to `@slkiser/opencode-quota@4`, applied like any other safe change.
- **Unknown** (for example, `opencode` is not on your PATH): `init` asks which OpenCode you use. `update` assumes OpenCode 2 and prints a note; on OpenCode 1, set `"plugin": ["@slkiser/opencode-quota@4"]` yourself.

## Read the preview

The preview can contain three sections:

- **Safe changes this command can make:** package-spec edits (in `plugin` and OpenCode 2 `plugins` entries; plugin options are kept) and recognized file-backed display-setting migration.
- **Manual actions — this command will not change these sources:** credential findings or config cases that require your review.
- **Package-cache candidates:** directories considered for removal. A candidate is removed only after current config and the package manifest are verified.

Empty sections are omitted. No updater-owned config or cache change happens before the preview and, for the interactive command, your confirmation.

The command uses two exit codes:

- `0`: applied, already current, successful dry-run, manual-only findings, or cancellation.
- `1`: invalid arguments, incomplete planning, a config race, a write failure, or post-write validation failure.

Manual findings do not make the command fail. They remain your responsibility.

## What can change automatically

The updater can:

- change supported OpenCode Quota plugin package specs to `@latest` (on OpenCode 1, pin them to `@4` instead);
- remove only package-cache directories that pass path, symlink, containment, and exact package-manifest checks;
- migrate recognized `opencodeZenDisplay` values in known file-backed quota config locations:
  - `"default"` becomes root `accountingDetail: "summary"`;
  - `"detailed"` becomes root `accountingDetail: "detailed"`;
- keep an existing valid `accountingDetail` value and remove the obsolete ignored key, even when the two values differ.

Targeted JSON/JSONC edits preserve unrelated settings, plugins, comments, trailing commas, and tuple options where the document can be edited safely. When the configured path is a supported symlink, the updater keeps that link and writes the verified regular-file target.

Unsupported or invalid display values, invalid replacement values, duplicate keys, ambiguous structures, malformed files, unsupported roots, and newly discovered symlinks are left unchanged for manual review. SDK-only config is diagnostic-only because it has no safe file path for the updater to edit.

## What stays manual

Credential findings are report-only. The audit detects known obsolete sources by variable-name or file-path presence without retrieving environment values or opening credential files. It never prints, copies, or deletes secret values, and it does not edit environment declarations, shell startup files, OpenCode's `opencode.db`, supported credential files, or legacy credential files.

### OpenCode Go findings

OpenCode Go now uses an official API key. Configure one supported source in this order:

1. `OPENCODE_API_KEY`
2. Trusted user/global OpenCode config: `provider.opencode-go.options.apiKey`
3. Trusted user/global fallback: `provider.opencode.options.apiKey`
4. An `opencode-go` API-key login saved in OpenCode 2 (`opencode.db`)
5. A legacy `opencode` API-key login as the final fallback

You can create the `opencode-go` API-key login with:

```bash
opencode auth login opencode-go
```

Verify the supported key with `/quota_status` or terminal `opencode-quota status`. Only after it works, manually remove obsolete declarations for `OPENCODE_GO_WORKSPACE_ID` and `OPENCODE_GO_AUTH_COOKIE`, plus any obsolete global `opencode-quota/opencode-go.json` file.

Workspace/cookie material cannot be converted into the official API key. Do not paste credential values into command output, issue reports, or support messages.

### OpenCode Zen findings

OpenCode Zen now uses your OpenCode Console sign-in: run `opencode auth login opencode` (and `opencode auth switch opencode` to pick a saved organization), then verify with `/quota_status` or terminal `opencode-quota status`. See [OpenCode Zen setup](providers.md#opencode-zen).

The updater reports two leftovers from the old workspace/cookie setup without reading or moving their values:

- A global `opencode-quota/opencode.json` file: it is no longer read. Remove it manually after Zen works.
- `OPENCODE_WORKSPACE_ID` / `OPENCODE_AUTH_COOKIE`: current quota code ignores them. They may come from an older Zen setup or belong to OpenCode's workspace feature. Remove them only if they held Zen credentials.

Never share the real values.

## Cancellation, failures, and reruns

Before updating, back up the OpenCode config files you use. This is especially important if you may roll back to an older plugin version, because old versions do not understand every current setting.

Cancelling the interactive prompt changes nothing. Dry-run also changes nothing. A successful migration is idempotent: rerunning does not repeat a completed display edit, though manual findings remain until you resolve their sources.

The updater checks every planned file again before writing and writes each changed file atomically. Supported configuration symlinks stay in place: the updater snapshots the link chain during planning, revalidates it immediately before writing, and updates the verified regular-file target. It fails closed on dangling links, loops, chains longer than 40 hops, non-regular targets, permission errors, retargeted links, destination-byte races, and JSON-to-JSONC conversions that would delete a symlink. It does not claim that several files form one transaction and it does not overwrite concurrent edits with an automatic rollback. If a later file changes or a write fails after earlier files were written, the error lists the files changed before failure and deletes no package cache. Fix the reported cause, inspect those paths, and rerun the dry-run command to build a fresh plan.
