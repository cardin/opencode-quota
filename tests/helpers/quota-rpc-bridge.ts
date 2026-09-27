import { expect } from "vitest";

type QuotaRpcHandler = (
  input: unknown,
  context: {
    signal: AbortSignal;
    error: (type: string, message: string, data?: unknown) => unknown;
  },
) => Promise<unknown>;

type QuotaRpcCallOptions = { location?: { directory: string }; signal?: AbortSignal };

/**
 * A TUI fake's `client.rpc` that calls the handlers a server fake registered with
 * `ctx.rpc.register`. Like OpenCode's HTTP route it carries JSON: input and output make a
 * JSON round trip, and an output that is not a pure JSON value fails the call.
 */
export function createQuotaRpcBridge(handlers: Record<string, QuotaRpcHandler>) {
  return (definition: { methods: Record<string, unknown> }) =>
    Object.fromEntries(
      Object.keys(definition.methods).map((method) => [
        method,
        async (input: unknown, options?: QuotaRpcCallOptions) => {
          expect(options?.location).toBeDefined();
          const output = await handlers[method](JSON.parse(JSON.stringify(input)), {
            signal: options?.signal ?? new AbortController().signal,
            error: (type, message, data) => ({ type, message, data }),
          });
          expect(output).toStrictEqual(JSON.parse(JSON.stringify(output)));
          return JSON.parse(JSON.stringify(output));
        },
      ]),
    );
}
