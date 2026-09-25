/** OpenCode V2 server plugin: quota slash commands for every client, plus a diagnostics tool. */
import { Plugin } from "@opencode/plugin";
import { resolveOpenCodeLocationRoots } from "./lib/config-file-utils.js";
import { sanitizeDisplayText } from "./lib/display-sanitize.js";
import { reconcileDetectedProvidersInGlobalConfig } from "./lib/opencode-config-providers.js";
import {
  buildQuotaDialogCommandOutput,
  QUOTA_DIALOG_COMMANDS,
  type QuotaDialogCommandId,
} from "./lib/quota-dialog-commands.js";
import {
  containsQuotaReport,
  formatQuotaReportMessage,
  QUOTA_REPORT_METADATA_KEY,
  type QuotaReportMetadata,
  removeQuotaReports,
} from "./lib/quota-report-message.js";

type ModelMessage = {
  readonly role: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string | null }>;
};

type ModelMessagePart = ModelMessage["content"][number];

function hasQuotaReportText(part: ModelMessagePart): boolean {
  return part.type === "text" && typeof part.text === "string" && containsQuotaReport(part.text);
}

/**
 * Drops quota report messages, found by their metadata, and cuts reports out of the text of
 * the remaining user messages. The cut covers compaction checkpoints, which hold copied
 * message text without its metadata, and title requests, which get plain text only.
 */
function withoutQuotaReports<M extends ModelMessage>(messages: M[]): M[] {
  return messages.flatMap((message): M[] => {
    if (message.role !== "user") return [message];
    if (message.metadata?.[QUOTA_REPORT_METADATA_KEY] !== undefined) return [];
    if (!message.content.some(hasQuotaReportText)) return [message];
    const content = message.content.map((part) =>
      hasQuotaReportText(part) ? { ...part, text: removeQuotaReports(part.text as string) } : part,
    );
    return [{ ...message, content }];
  });
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

    // Web, Desktop, and the TUI list these in their "/" menu. The TUI opens its dialog when
    // a report arrives; its command palette runs the same reports without posting them.
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
            // A message admitted while the AI works is delivered into that turn at its next
            // step, and can make the AI take one more step. Wait until the session is idle.
            await ctx.session.wait({ sessionID: invocation.sessionID });
            const metadata: QuotaReportMetadata = {
              command: spec.id,
              title: result.title,
              at: Date.now(),
            };
            // The report is posted as the user's message. resume: false admits it without
            // starting a model turn, so it waits in the session inbox, where Web, Desktop,
            // and the TUI show it. "steer" delivers it together with the user's next message;
            // "queue" would later give it a model turn of its own.
            await ctx.session.prompt({
              sessionID: invocation.sessionID,
              text: formatQuotaReportMessage(sanitizeDisplayText(result.output)),
              metadata: { [QUOTA_REPORT_METADATA_KEY]: metadata },
              delivery: "steer",
              resume: false,
            });
          },
        });
      }
    });

    // Keep quota reports out of every model request built from session history:
    // normal turns, compaction summaries, and generate requests.
    for (const hook of ["context", "compaction", "generate"] as const) {
      await ctx.session.hook(hook, (event) => {
        event.messages = withoutQuotaReports(event.messages);
      });
    }
    // OpenCode titles a new session from its first user message, which can be a report.
    // With nothing else to title from, skip the title request and keep the default title.
    await ctx.session.hook("title", (event) => {
      if (!event.messages.some((message) => message.content.some(hasQuotaReportText))) return;
      event.messages = withoutQuotaReports(event.messages);
      const textLeft = event.messages.some((message) =>
        message.content.some((part) => part.type === "text" && part.text.trim() !== ""),
      );
      if (!textLeft) event.result = "";
    });
  },
});

export default QuotaToastPlugin;
