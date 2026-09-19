# Upstream sync notes: OpenCode v2 credential store

This fork adds OpenCode 2 credential-store support (`opencode.db` → `credential`)
to the provider API-key resolver. Upstream is independently implementing the same
migration in **PR #196 "feat(tui): migrate quota sidebar and commands to TUI V2"**
(`slkiser/opencode-quota`). The two overlap on the same files and lines, so a
plain `git merge upstream/main` after #196 lands will conflict.

This document records the exact overlap and how to resolve it.

## What this fork adds

Layered, v2-first resolution:

```
env → opencode.json(c) → opencode.db credential store → auth.json (fallback)
```

- New module `src/lib/opencode-credential-store.ts`
  (`readOpenCodeCredentialsCached`, `normalizeStoredCredential`, source literal
  `OPENCODE_CREDENTIAL_SOURCE = "opencode.credentials"`).
- Re-exported through `src/lib/opencode-auth.ts`.
- Wired into `src/lib/api-key-resolver.ts` via `credentialIntegrationIds` and
  `resolveOpenCodeCredentialKey` (both simple and invalid-aware policies).
- New source literal plumbed through `entries.ts`, `quota-state-codec.ts`,
  `quota-status.ts`, `providers/quota-providers.ts` as `"opencode_credentials"`.
- All 11 resolver-based providers get `| OpenCodeCredentialSource` added to their
  source unions plus a matching `…AuthSource` alias.

Regenerate a standalone patch (tracked edits plus the three new files):

```bash
NEW="src/lib/opencode-credential-store.ts tests/lib.api-key-resolver-v2-credentials.test.ts tests/lib.opencode-credential-store.test.ts"
git add -N $NEW
git diff HEAD -- $NEW src/lib src/providers                      > opencode-v2-credentials.patch
git reset -q -- $NEW
```

## What upstream #196 does (same migration, different shape)

- `src/lib/opencode-auth.ts` gains `readCredentialRows()`,
  `getCredentialDatabasePaths()`, `getCredentialDatabasePath()`,
  `selectConnectionCredentialRows()`, `formatCredentialDisplayNames()`.
  `readAuthFile()` now reads the credential table directly and normalizes
  `{"type":"key"}` → `{"type":"api"}`. `getAuthPaths()` survives only for Cursor
  OAuth legacy.
- Renames:
  - `getAuthPaths` → `getCredentialDatabasePaths`
  - diagnostics `authPaths` → `credentialDatabasePaths`
  - source literal `"auth.json"` → `"opencode.db"`
  - accounting value `"auth_json"` → `"opencode_db"`
- Drops the auth.json read path (this fork keeps it as a fallback).

Result: upstream's `readAuth` is DB-backed, which makes this fork's layered
v2-first lookup redundant once #196 is in.

## Conflict map

| File | Fork change | Upstream #196 change | Resolution |
| --- | --- | --- | --- |
| `src/lib/opencode-credential-store.ts` | new module | n/a (logic lives in `opencode-auth.ts`) | Prefer upstream: delete module (see below) |
| `src/lib/opencode-auth.ts` | added re-export block | full DB reader rewrite | Take upstream; drop re-export |
| `src/lib/api-key-resolver.ts` | `credentialIntegrationIds` fields + helpers + v2-first calls | rename `getAuthPaths`/`authPaths` + comments | Take upstream renames; drop fork helpers/fields |
| `src/lib/opencode-go-auth.ts` | `\| OpenCodeCredentialSource`, `OpenCodeGoAuthSource` | `"auth.json"` → `"opencode.db"`, `getCredentialDatabasePaths` | Take upstream; delete extra alias/member |
| `src/lib/zai-auth.ts` | same | same | same |
| `src/lib/zhipu-auth.ts` | same | same | same |
| `src/lib/kimi-auth.ts` | same | same | same |
| `src/lib/deepseek-auth.ts` | `\| OpenCodeCredentialSource` | `"auth.json"` → `"opencode.db"` | same |
| `src/lib/nanogpt-config.ts` | same | same | same |
| `src/lib/chutes-config.ts` | same | same | same |
| `src/lib/ollama-cloud-config.ts` | same | same | same |
| `src/lib/synthetic-config.ts` | same | same | same |
| `src/lib/kilo-config.ts` | same | same | same |
| `src/lib/quota-providers-remote.ts` | `\| OpenCodeCredentialSource` | `"auth.json"` → `"opencode.db"` | same |
| `src/lib/entries.ts` | `\| "opencode_credentials"` | `"auth_json"` → `"opencode_db"`, `authPaths` rename | Take upstream; drop fork value |
| `src/lib/quota-state-codec.ts` | `"opencode_credentials"` in allow-list | `"auth_json"` → `"opencode_db"` | Take upstream |
| `src/lib/quota-status.ts` | `opencode_credentials` case | `"auth_json"` → `"opencode_db"` | Take upstream |
| `src/providers/quota-providers.ts` | `opencode.credentials` case | `"auth.json"` → `"opencode.db"`, `auth_json` → `opencode_db` | Take upstream |
| `tests/lib.opencode-credential-store.test.ts` | new | n/a | Delete with the module |
| `tests/lib.api-key-resolver-v2-credentials.test.ts` | new | n/a | Delete or retarget to upstream's `readCredentialRows` |

## Recommended resolution (adopt upstream)

Because #196 makes `readAuthFile` DB-backed, the fork's separate layer is
duplicate work. After merging #196:

1. Take upstream for every conflict.
2. Delete `src/lib/opencode-credential-store.ts` and the re-export block in
   `src/lib/opencode-auth.ts`.
3. In `src/lib/api-key-resolver.ts` remove: `getOpenCodeCredentialReader`,
   `resolveOpenCodeCredentialKey`, both `credentialIntegrationIds` fields, and the
   two call sites; keep upstream's renamed interfaces.
4. Delete the two new test files (upstream covers the DB reader).
5. Keep only the fork's auth.json fallback if still desired — upstream dropped it,
   so re-adding it is a deliberate divergence. Otherwise take upstream entirely.

Behavior is preserved: credentials resolve from `opencode.db`, the stale
`auth.json` key is no longer used, and diagnostics report `"opencode.db"`.

## Alternate resolution (keep the layered v2-first design)

If you want to keep strict v2-first + auth.json fallback:

1. Rename the literal to upstream's `"opencode.db"` and the accounting value to
   `"opencode_db"` (so those hunks match upstream and merge cleanly).
2. Replace the fork's SQLite code with upstream's `readCredentialRows()`, grouping
   by `integrationId` inside `readOpenCodeCredentialsCached`.
3. Remove the added `| OpenCodeCredentialSource` union members and `…AuthSource`
   aliases — reuse the existing (now `"opencode.db"`) source.
4. Keep `credentialIntegrationIds` and `resolveOpenCodeCredentialKey` only if
   multi-credential selection is still needed.
5. Retarget the two new tests at `readCredentialRows`.

This keeps the fallback but shrinks the conflict surface to `api-key-resolver.ts`
and `opencode-auth.ts`.

## Merge recipe

```bash
git fetch upstream
git checkout main
git merge upstream/main            # conflicts per the map above
# resolve, then:
pnpm run typecheck
pnpm run check
pnpm test
pnpm run build
```

## Verification

```bash
node --input-type=module -e '
const base = "/home/cardi/projects_l/opencode-quota/dist/lib";
const { resolveOpenCodeGoAuthCached, getOpenCodeGoAuthDiagnostics } = await import(base + "/opencode-go-auth.js");
const { queryOpenCodeGoQuota } = await import(base + "/opencode-go.js");
const resolved = await resolveOpenCodeGoAuthCached({ maxAgeMs: 0 });
console.log("state:", resolved.state, "key prefix:", resolved.state === "configured" ? resolved.apiKey.slice(0, 3) : "-");
if (resolved.state === "configured") {
  const quota = await queryOpenCodeGoQuota(resolved.apiKey, {});
  console.log("quota:", quota.success ? "200" : quota.error);
}
console.log("source:", (await getOpenCodeGoAuthDiagnostics({ maxAgeMs: 0 })).source);
'
```

Expected: `state: configured`, key prefix `oc_`, `quota: 200`, and source
`opencode.db` (after #196) or `opencode.credentials` (current fork patch).
