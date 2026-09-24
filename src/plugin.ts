/**
 * OpenCode Quota Toast Plugin (OpenCode 2)
 *
 * Shows deterministic quota output without LLM invocation.
 *
 * OpenCode 2 plugins are defined with `Plugin.define({ id, setup })` and
 * register capabilities through the plugin context. The quota engine itself
 * (`src/lib`, `src/providers`) is unchanged; only this entrypoint and its
 * client adapter target the V2 API.
 */

import { Plugin } from "@opencode/plugin";
import { runWithAbortSignal } from "./lib/abort-context.js";
import { findGitWorktreeRoot, getEffectiveConfigRoot } from "./lib/config-file-utils.js";
import { sanitizeDisplayText } from "./lib/display-sanitize.js";
import { reconcileDetectedProvidersInGlobalConfig } from "./lib/opencode-config-providers.js";
import {
  buildQuotaDialogCommandOutput,
  QUOTA_DIALOG_COMMANDS,
  type QuotaDialogCommandId,
} from "./lib/quota-dialog-commands.js";
import type { SessionModelMeta } from "./lib/quota-render-data.js";
import type { SessionTokenError } from "./lib/quota-status.js";
import { disposeQuotaTelemetryOwner } from "./lib/quota-telemetry.js";
import { createV2QuotaClient } from "./lib/v2-quota-client.js";

export const QUOTA_PLUGIN_ID = "@cardinal4/opencode-quota";

export const QuotaToastPlugin = Plugin.define({
  id: QUOTA_PLUGIN_ID,
  async setup(ctx) {
    // The quota engine only needs the V1-shaped config slice. V2 exposes the
    // provider catalog directly on the context.
    const quotaClient = createV2QuotaClient({
      providerList: async () => {
        try {
          const output = await ctx.provider.list();
          return { data: output.data };
        } catch {
          return { data: [] };
        }
      },
    });

    const directory = ctx.location.directory;

    // Track last session token error for /quota_status diagnostics
    let lastSessionTokenError: SessionTokenError | undefined;

    function getPluginRuntimeRootHints() {
      const cwd = directory || process.cwd();
      const workspaceRoot = findGitWorktreeRoot(cwd) ?? cwd;
      const configRoot = getEffectiveConfigRoot(workspaceRoot);
      return {
        workspaceRoot,
        configRoot,
        fallbackDirectory: cwd,
      };
    }

    /**
     * Log a message. OpenCode 2 plugin contexts do not expose the V1
     * `client.app.log` endpoint; plugin output is captured by the service log.
     */
    async function log(message: string, extra?: Record<string, unknown>): Promise<void> {
      try {
        if (extra === undefined) {
          console.error(`[quota-toast] ${message}`);
        } else {
          console.error(`[quota-toast] ${message}`, extra);
        }
      } catch {
        // Logging must never break quota output.
      }
    }

    /**
     * Inject deterministic output into the session transcript without
     * triggering an LLM response or adding anything to the model context.
     *
     * OpenCode 2 renders a synthetic message's `description` in the transcript
     * and treats `text` as model-facing input. `resume: false` admits the
     * message without scheduling execution, so the output stays visible to the
     * user while the model never runs and never sees the text, matching V1's
     * `noReply` + `ignored` injection.
     */
    async function injectRawOutput(
      sessionID: string,
      output: string,
      options: { rethrow?: boolean } = {},
    ): Promise<void> {
      try {
        await ctx.session.synthetic({
          sessionID,
          text: "",
          description: sanitizeDisplayText(output),
          resume: false,
        });
      } catch (err) {
        await log("Failed to inject raw output", {
          error: err instanceof Error ? err.message : String(err),
        });
        if (options.rethrow) {
          throw err;
        }
      }
    }

    async function isSubagentSession(sessionID: string): Promise<boolean> {
      try {
        const session = await ctx.session.get({ sessionID });
        return Boolean(session.parentID);
      } catch {
        return false;
      }
    }

    /**
     * Get the current model metadata from the active session.
     */
    async function getSessionModelMeta(sessionID?: string): Promise<SessionModelMeta> {
      if (!sessionID) return {};
      try {
        const session = await ctx.session.get({ sessionID });
        return {
          modelID: session.model?.id,
          providerID: session.model?.providerID,
        };
      } catch {
        return {};
      }
    }

    let providerConfigReconcileQueue: Promise<void> = Promise.resolve();

    async function reconcileDetectedProviderConfig(providerIds: readonly string[]): Promise<void> {
      if (!directory || providerIds.length === 0) return;

      const reconcile = async () => {
        try {
          const result = await reconcileDetectedProvidersInGlobalConfig({
            configRootDir: getPluginRuntimeRootHints().configRoot,
            detectedProviderIds: providerIds,
          });
          if (result.changed) {
            await log("Added detected providers to global OpenCode config", {
              path: result.path,
              format: result.format,
              providers: result.addedProviderIds,
            });
          }
        } catch (error) {
          await log("Failed to add detected providers to global OpenCode config", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };

      providerConfigReconcileQueue = providerConfigReconcileQueue.then(reconcile, reconcile);
      await providerConfigReconcileQueue;
    }

    async function handleDeterministicSlashCommand(input: {
      command: QuotaDialogCommandId;
      arguments?: string;
      sessionID?: string;
    }): Promise<void> {
      const result = await buildQuotaDialogCommandOutput({
        command: input.command,
        arguments: input.arguments,
        client: quotaClient,
        roots: getPluginRuntimeRootHints(),
        sessionID: input.sessionID,
        resolveSessionMeta: (sessionID) => getSessionModelMeta(sessionID),
        lastSessionTokenError,
        setLastSessionTokenError: (error) => {
          lastSessionTokenError = error;
        },
        log,
      });

      if (result.state === "output" && input.sessionID) {
        await injectRawOutput(input.sessionID, result.output, { rethrow: true });
      }
    }

    // Register the deterministic slash commands. V2 commands replace the V1
    // `config` hook plus `command.execute.before` interception.
    await ctx.command.transform((editor) => {
      for (const spec of QUOTA_DIALOG_COMMANDS) {
        editor.add({
          name: spec.slashName,
          description: spec.description,
          execute: async ({ sessionID, prompt }) => {
            await handleDeterministicSlashCommand({
              command: spec.id,
              arguments: prompt.text,
              sessionID,
            });
          },
        });
      }
    });

    // Register the `quota_status` tool. V2 tool definitions use JSON Schema and
    // return structured content.
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "quota_status",
        description:
          "Diagnostics for toast + TUI + pricing + local storage (includes unknown pricing report).",
        input: {
          type: "object",
          properties: {
            refreshGoogleTokens: {
              type: "boolean",
              description: "If true, refresh Google Antigravity access tokens before reporting",
            },
            skewMs: {
              type: "number",
              minimum: 0,
              description: "Refresh tokens expiring within this window (ms). Default: 120000",
            },
            force: {
              type: "boolean",
              description: "If true, refresh even if cached token looks valid",
            },
          },
          additionalProperties: false,
        },
        execute: async (input, tool) => {
          const args = input as {
            refreshGoogleTokens?: boolean;
            skewMs?: number;
            force?: boolean;
          };
          // `ToolContext.signal` was added in OpenCode 2.0.12; read it
          // defensively so the plugin still type-checks against the 2.0.7
          // contract it declares as its peer while using it on newer hosts.
          const signal = (tool as { signal?: AbortSignal }).signal;
          let result: Awaited<ReturnType<typeof buildQuotaDialogCommandOutput>>;
          try {
            // Run the whole probe inside the tool's cancellation scope so the
            // provider HTTP calls in `fetchWithTimeout` abort when the session
            // stops instead of running to their timeout.
            result = await runWithAbortSignal(signal, () =>
              buildQuotaDialogCommandOutput({
                command: "quota_status",
                arguments: JSON.stringify({
                  refreshGoogleTokens: args.refreshGoogleTokens,
                  skewMs: args.skewMs,
                  force: args.force,
                }),
                client: quotaClient,
                roots: getPluginRuntimeRootHints(),
                sessionID: tool.sessionID,
                resolveSessionMeta: (sessionID) => getSessionModelMeta(sessionID),
                lastSessionTokenError,
                onDetectedProviderIds: reconcileDetectedProviderConfig,
                log,
              }),
            );
          } catch (error) {
            // A cancelled tool call is not a failure; report no content.
            if (signal?.aborted) return { content: "" };
            throw error;
          }
          if (result.state === "output") {
            await injectRawOutput(tool.sessionID, result.output);
          }
          return { content: "" };
        },
      });
    });

    await log("plugin initialized", {
      directory,
      providers: (await ctx.provider.list()).data.length,
    });

    return () => {
      disposeQuotaTelemetryOwner(quotaClient);
    };
  },
});

export default QuotaToastPlugin;
