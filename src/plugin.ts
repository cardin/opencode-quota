/** OpenCode V2 server plugin: quota slash commands for Web and Desktop, plus a diagnostics tool. */
import { Plugin } from "@opencode/plugin";
import { resolveOpenCodeLocationRoots } from "./lib/config-file-utils.js";
import { sanitizeDisplayText } from "./lib/display-sanitize.js";
import { reconcileDetectedProvidersInGlobalConfig } from "./lib/opencode-config-providers.js";
import {
  buildQuotaDialogCommandOutput,
  QUOTA_DIALOG_COMMANDS,
  type QuotaDialogCommandId,
} from "./lib/quota-dialog-commands.js";

/**
 * The model-facing text of every quota slash command message. The report itself goes in
 * the synthetic message's `description`, which Web, Desktop, and the TUI display but
 * OpenCode never sends to the model. The session hooks below drop messages with exactly
 * this text, so they never reach the model either. The text is stored with the message,
 * so the filter keeps working after a restart.
 */
const QUOTA_COMMAND_MESSAGE_TEXT =
  "[OpenCode Quota slash command output. Shown to the user only; not part of the conversation.]";

type ModelMessage = {
  readonly role: string;
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string | null }>;
};

function withoutQuotaCommandMessages<M extends ModelMessage>(messages: M[]): M[] {
  return messages.filter(
    (message) =>
      !(
        message.role === "user" &&
        message.content.length === 1 &&
        message.content[0].type === "text" &&
        message.content[0].text === QUOTA_COMMAND_MESSAGE_TEXT
      ),
  );
}

export const QuotaToastPlugin = Plugin.define({
  id: "@slkiser/opencode-quota.server",
  async setup(ctx) {
    const roots = resolveOpenCodeLocationRoots(ctx.location.directory);
    // The quota collector accepts a small V1-shaped configuration client. V2
    // does not expose a mutable global config to plugins; quota settings are
    // read from the plugin's own config file by the collector.
    const client = {
      config: {
        get: async () => ({ data: {} }),
        providers: async () => ({
          data: {
            providers: (await ctx.provider.list()).data.map((provider) => ({ id: provider.id })),
          },
        }),
      },
    };

    const buildOutput = (
      command: QuotaDialogCommandId,
      sessionID: string,
      argumentsText?: string,
    ) =>
      buildQuotaDialogCommandOutput({
        command,
        arguments: argumentsText,
        client,
        roots,
        sessionID,
        resolveSessionMeta: async (id) => {
          const session = await ctx.session.get({ sessionID: id });
          return { modelID: session.model?.id, providerID: session.model?.providerID };
        },
        onDetectedProviderIds: async (providerIds) => {
          if (providerIds.length === 0) return;
          try {
            await reconcileDetectedProvidersInGlobalConfig({
              configRootDir: roots.configRoot,
              detectedProviderIds: providerIds,
            });
          } catch (error) {
            console.warn("Failed to add detected providers to global OpenCode config", error);
          }
        },
      });

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "quota_status",
        description: "Diagnostics for toast, TUI, pricing and local storage.",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        async execute(_input, context) {
          const result = await buildOutput("quota_status", context.sessionID);
          return { content: result.state === "output" ? sanitizeDisplayText(result.output) : "" };
        },
      });
    });

    // Web and Desktop list these in their "/" menu. The TUI also registers dialog
    // commands with the same names, so the TUI "/" menu lists each name twice.
    await ctx.command.transform((editor) => {
      for (const spec of QUOTA_DIALOG_COMMANDS) {
        editor.add({
          name: spec.slashName,
          description: spec.description,
          async execute(invocation) {
            const result = await buildOutput(
              spec.id,
              invocation.sessionID,
              invocation.prompt.text.trim() || undefined,
            );
            if (result.state === "noop") return;
            // resume: false admits the message without starting a model turn. It waits in the
            // session inbox until the next prompt; Web, Desktop, and the TUI show it right away.
            await ctx.session.synthetic({
              sessionID: invocation.sessionID,
              text: QUOTA_COMMAND_MESSAGE_TEXT,
              description: sanitizeDisplayText(result.output),
              resume: false,
            });
          },
        });
      }
    });

    // Keep quota command messages out of every model request built from session history:
    // normal turns, compaction summaries, and generate requests.
    for (const hook of ["context", "compaction", "generate"] as const) {
      await ctx.session.hook(hook, (event) => {
        event.messages = withoutQuotaCommandMessages(event.messages);
      });
    }
  },
});

export default QuotaToastPlugin;
