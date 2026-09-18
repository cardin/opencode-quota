/**
 * OpenCode 2 CLI (TUI) host adapter.
 *
 * The quota terminal surfaces were written against the OpenCode 1 TUI plugin
 * API (`TuiPluginApi`). OpenCode 2 exposes a different CLI plugin context.
 * `TuiHost` is the small, stable surface the quota UI actually consumes, and
 * `createTuiHost` implements it on top of the V2 context so the rendering code
 * and quota engine stay shared.
 */

import type { Plugin } from "@opencode/plugin/tui";
import type { RGBA } from "@opentui/core";

type Context = Plugin.Context;

export type TuiHostEvent = {
  readonly type: string;
  readonly properties: {
    readonly sessionID?: string;
    readonly info?: {
      readonly id?: string;
      readonly sessionID?: string;
    };
  };
};

export type TuiHost = {
  readonly state: {
    readonly path: {
      readonly worktree: string;
      readonly directory: string;
    };
    readonly provider: ReadonlyArray<{ id: string }>;
    readonly session: {
      messages: (sessionID: string) => ReadonlyArray<unknown>;
      get?: (sessionID: string) => unknown;
      status?: (sessionID: string) => { type?: string } | undefined;
    };
  };
  readonly client: {
    config: {
      providers: () => Promise<{ data: { providers: Array<{ id: string }> } }>;
      get: () => Promise<{ data: Record<string, unknown> }>;
    };
    session: {
      get: (input: {
        sessionID: string;
      }) => Promise<{ data?: { model?: { id?: string; providerID?: string } } }>;
      synthetic: (input: {
        sessionID: string;
        text: string;
        description?: string;
      }) => Promise<unknown>;
    };
  };
  readonly kv: {
    get: <Value = unknown>(key: string, fallback?: Value) => Value;
    set: (key: string, value: unknown) => void;
  };
  readonly theme: {
    readonly current: {
      readonly text: RGBA;
      readonly textMuted: RGBA;
    };
  };
  readonly event: {
    on: (type: string, handler: (event: TuiHostEvent) => void) => () => void;
  };
  readonly log: (message: string, extra?: Record<string, unknown>) => Promise<void>;
};

/**
 * V1 TUI event names -> V2 server event names that should trigger the same
 * quota refresh. Handlers only need the session id, which the adapter
 * normalizes into the V1 `properties` shape.
 */
const EVENT_MAP: Record<string, readonly string[]> = {
  "session.updated": [
    "session.status",
    "session.created",
    "session.renamed",
    "session.model.selected",
    "session.agent.selected",
    "session.execution.started",
    "session.execution.succeeded",
    "session.execution.failed",
    "session.compacted",
  ],
  "message.updated": ["session.message.content.updated", "session.usage.updated"],
  "message.removed": ["session.message.content.updated"],
  "session.status": [
    "session.status",
    "session.execution.started",
    "session.execution.succeeded",
    "session.execution.failed",
  ],
  "tui.session.select": ["tui.session.select"],
};

function extractEventSessionID(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  const direct = record.sessionID;
  if (typeof direct === "string") return direct;
  const info = record.info;
  if (info && typeof info === "object") {
    const infoRecord = info as Record<string, unknown>;
    if (typeof infoRecord.id === "string") return infoRecord.id;
    if (typeof infoRecord.sessionID === "string") return infoRecord.sessionID;
  }
  return undefined;
}

export function createTuiHost(context: Context): TuiHost {
  const [kvStore, updateKv] = context.storage.memory<Record<string, unknown>>("quota-ui", {
    initial: {},
  });

  return {
    state: {
      path: {
        worktree: context.location?.directory ?? process.cwd(),
        directory: context.location?.directory ?? process.cwd(),
      },
      provider: context.data.location.provider.list(context.location) ?? [],
      session: {
        messages: (sessionID: string) =>
          context.data.session.message.list(sessionID) as ReadonlyArray<unknown>,
        get: (sessionID: string) => context.data.session.get(sessionID),
        status: (sessionID: string) => {
          const status = context.data.session.status(sessionID);
          return { type: status === "running" ? "busy" : "idle" };
        },
      },
    },
    client: {
      config: {
        providers: async () => {
          try {
            const output = await context.client.provider.list();
            return { data: { providers: output.data ?? [] } };
          } catch {
            return { data: { providers: [] } };
          }
        },
        get: async () => ({ data: {} }),
      },
      session: {
        get: async (input) => {
          try {
            const session = await context.client.session.get({ sessionID: input.sessionID });
            return { data: { model: session.model } };
          } catch {
            return {};
          }
        },
        synthetic: async (input) =>
          context.client.session.synthetic({
            sessionID: input.sessionID,
            text: input.text,
            ...(input.description ? { description: input.description } : {}),
          }),
      },
    },
    kv: {
      get: <Value = unknown>(key: string, fallback?: Value): Value => {
        const value = kvStore[key];
        return (value === undefined ? fallback : value) as Value;
      },
      set: (key: string, value: unknown) => {
        updateKv((draft) => {
          draft[key] = value;
        });
      },
    },
    theme: {
      current: {
        text: context.theme.text.default,
        textMuted: context.theme.text.subdued,
      },
    },
    event: {
      on: (type, handler) => {
        const mapped = EVENT_MAP[type] ?? [type];
        const disposers = mapped.map((eventType) =>
          (context.data.on as unknown as (t: string, h: (event: unknown) => void) => () => void)(
            eventType,
            (event) => {
              const record = (event ?? {}) as { type?: string; data?: unknown };
              const sessionID = extractEventSessionID(record.data);
              handler({
                type: record.type ?? eventType,
                properties: {
                  sessionID,
                  info: sessionID === undefined ? undefined : { id: sessionID, sessionID },
                },
              });
            },
          ),
        );
        return () => {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch {
              // Disposal is best-effort.
            }
          }
        };
      },
    },
    log: async (message, extra) => {
      try {
        if (extra === undefined) {
          console.error(`[quota-toast] ${message}`);
        } else {
          console.error(`[quota-toast] ${message}`, extra);
        }
      } catch {
        // Logging must never break rendering.
      }
    },
  };
}
