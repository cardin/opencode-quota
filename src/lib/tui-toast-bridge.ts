/**
 * OpenCode 2 CLI toast bridge.
 *
 * In OpenCode 1 the server plugin could call `client.tui.showToast`. OpenCode 2
 * removed the server-side toast endpoint: toasts belong to the terminal client.
 * This bridge runs the shared quota toast runtime inside the CLI plugin and
 * renders its output with `context.ui.toast`.
 */

import type { Plugin } from "@opencode/plugin/tui";
import { resolveRuntimeContextRoots } from "./config-file-utils.js";
import { reconcileDetectedProvidersInGlobalConfig } from "./opencode-config-providers.js";
import type { SessionTokenError } from "./quota-status.js";
import { createQuotaToastRuntime } from "./quota-toast-runtime.js";
import type { TuiHost } from "./tui-host.js";
import {
  createTuiQuotaClient,
  getTuiRuntimeRootHints,
  getTuiSessionModelMeta,
} from "./tui-runtime.js";

type Context = Plugin.Context;

export function startTuiToastRuntime(context: Context, host: TuiHost): () => void {
  let lastSessionTokenError: SessionTokenError | undefined;

  const runtime = createQuotaToastRuntime({
    client: createTuiQuotaClient(host),
    roots: () => getTuiRuntimeRootHints(host),
    resolveSessionMeta: (sessionID) => getTuiSessionModelMeta(host, sessionID),
    isSubagentSession: async (sessionID) => {
      try {
        return Boolean(context.data.session.get(sessionID)?.parentID);
      } catch {
        return false;
      }
    },
    reconcileDetectedProviders: async (providerIds) => {
      if (providerIds.length === 0) return;
      const roots = resolveRuntimeContextRoots(getTuiRuntimeRootHints(host));
      try {
        await reconcileDetectedProvidersInGlobalConfig({
          configRootDir: roots.configRoot,
          detectedProviderIds: providerIds,
        });
      } catch (error) {
        await host.log("Failed to reconcile detected providers", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    setSessionTokenError: (error) => {
      lastSessionTokenError = error;
    },
    showToast: async (body) => {
      context.ui.toast.show({
        message: body.message,
        variant: body.variant,
        ...(body.title ? { title: body.title } : {}),
        ...(body.duration ? { duration: body.duration } : {}),
      });
    },
    log: (message, extra) => host.log(message, extra),
    onInitialized: (extra) => {
      void host.log("toast runtime initialized", extra);
    },
  });

  const handleTrigger = (trigger: string, sessionID: string | undefined): void => {
    if (!sessionID) return;
    void runtime.handleTrigger({ sessionID, trigger });
  };

  const disposers: Array<() => void> = [
    context.data.on("session.idle", (event) => {
      handleTrigger("session.idle", event.data?.sessionID);
    }),
    context.data.on("session.compaction.ended", (event) => {
      handleTrigger("session.compacted", event.data?.sessionID);
    }),
  ];

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // Disposal is best-effort.
      }
    }
  };
}
